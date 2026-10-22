// Local
// =====
// One chat run in this process, for the terminal harness (unii.ts): the
// chat's turns, its memory tree and the agent loop, with no server, port
// or socket. A turn's call gets its tools in process (AskAI.ts Provider):
// zoom and date read the memory; shell, read, write and edit run here, in
// the working directory. As in the server (UniiChat's Server.ts Chat), one turn runs
// at a time; a message sent while its call runs reaches the model between
// tool calls (Agent.ts), one sent while it waits on summaries joins it;
// the summaries build in the background, JOBS at a time (Memory.ts). What
// runs is saved as it changes (Memory.ts `work`), so a turn a crash cut
// goes on when the chat opens next (Local.resume). Every message is
// logged as it comes, and flushed (Disk.ts).

import * as fs from "node:fs";
import * as path from "node:path";
import { AskAI, type Call, type End, type Event, type Kind, type Provider, type Used } from "./AskAI.ts";
import type { Out } from "./Agent.ts";
import * as config from "./Config.ts";
import { Disk } from "./Disk.ts";
import { live_push, type Live } from "./Live.ts";
import { INT, Machine, TOOLS, spec, type Spec } from "./Machine.ts";
import { Memory, type Share } from "./Memory.ts";
import { Pick } from "./Pick.ts";
import { Price } from "./Price.ts";
import PROMPT from "./prompt.txt" with { type: "text" };

// Types
// =====

// a message logged: its first page, and the count after its last
export type Msg = { id: number; end: number };

// a message's page as the terminal shows it; more: the next page goes on
// with its text
export type Shown = { id: number; kind: Kind; text: string; date: string; more: boolean };

// what the chat tells its terminal (or print mode): each message logged,
// what streams, a thought (shown, never logged), its state, a call's end
export type Hooks = {
  entry : (msg: Shown) => void;
  live  : (live: Live[]) => void;
  mind  : (text: string) => void;
  state : () => void;
  ended : (end: End) => void;
};

// the tokens a turn's last request read (its context) and wrote, and
// what its calls and summaries would cost at list prices (micro-USD;
// plans pay none of it)
export type Use = { context: number; output: number; micros: number };

// the chat: its working dir, memory, pick; busy: a turn runs; call: its
// model call; check: its goal check; sent, wait: messages the call took
// and those waiting; live: what streams; calls: tool calls without their
// results; tool: the tool running, if any
export type Chat = {
  cwd    : string;
  mem    : Memory;
  pick   : Pick;
  hooks  : Hooks;
  busy   : boolean;
  call   : Call | null;
  check  : Call | null;
  sent   : Msg[];
  wait   : Msg[];
  halt   : AbortController;
  live   : Live[];
  calls  : Record<string, string>;
  tool   : string | null;
  use    : Use;
  closed : boolean;
};

// Constants
// =========

// how the chat's work is saved (Memory.ts `work`), as the server saves it
export const TURN = "Unii's turn";

const HEAD    = "Turn: the user's new message:\n\n";
const GOAL    = "You check a goal. Below is a chat between a user and Unii, an AI agent: its older messages as summary lines (id+n|text), then its latest messages whole, then the goal the user set with /goal. Answer yes if the chat shows the goal fully satisfied now, else no. Write that one word, nothing else.";
const GOAL_ASK = "\nThe goal:\n\n";
const GOAL_NO = "The goal isn't satisfied yet: keep working.";

// the master's prompt, its parts on devices and agents made the harness's:
// one computer, the user's, and its working directory
const PARTS: Array<[string, string]> = [
  [" Use subagents only when the user asks for them.", ""],
  [`Messages the user sends while you work reach you between tool calls. Subagents
and computer tasks run in the background; each one's report reaches you as a
message starting "[Name]", between your tool calls or as a new turn. Never wait
for one (no sleep, no polling): go on, or end your turn and tell the user what
is running.`, `Messages the user sends while you work reach you between tool calls.`],
  [`The user's computers that have unii open now are listed at the start of each
message. Your shell, read, write and edit tools run on the one their \`device\`
field names; computer tasks, on one marked "computer use". A task that needs a
computer not listed can't be done now: tell the user.`, `You run in the user's terminal, on their computer. Your shell, read, write and
edit tools run there, in the working directory named at the start of each
message; a relative path is taken from it. Show the user what you changed.`],
];

export const SYSTEM = PARTS.reduce((text, [part, now]) => {
  if (!text.includes(part)) {
    throw new Error("prompt.txt changed: no part " + JSON.stringify(part.slice(0, 40)));
  }
  return text.replace(part, now);
}, PROMPT.trim());

// the project's own instructions, read from the working dir as a turn begins
const PROJECT = ["AGENTS.md", "CLAUDE.md"];

const OWN: Spec[] = [
  spec("zoom", "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole. A long text comes in pages from character at, saying where to go on.", { id: INT, n: INT, at: INT }, ["id"]),
  spec("date", "The date and time of message id.", { id: INT }, ["id"]),
];

// Local
// =====

export namespace Local {

  export function open(dir: string, cwd: string, hooks: Hooks): Chat {
    fs.mkdirSync(dir, { recursive: true });
    const mem = Memory.load(dir, () => Local.share(chat));
    const pick = Pick.load(mem.pick, config.OFFER, config.PICK);
    const chat: Chat = {
      cwd, mem, pick, hooks, busy: false, call: null, check: null, sent: [], wait: [], halt: new AbortController(),
      live: [], calls: {}, tool: null, use: { context: 0, output: 0, micros: 0 }, closed: false,
    };
    mem.wait.add(() => hooks.state());
    return chat;
  }

  // what a call starts with, a summary's too: the system prompt, and the
  // user's rules (config `rules`, then the project's). A summary gets no
  // tools; what each request used is added up
  export function share(chat: Chat): Share {
    const used = (u: Used) => Local.used(chat, u, false);
    return { ...Pick.ask(chat.pick), system: SYSTEM + Local.rules(chat.cwd), searches: 0, server: "", used };
  }

  export function rules(cwd: string): string {
    const files = [config.RULES, ...PROJECT.map((name) => path.join(cwd, name))].filter((file) => file && fs.existsSync(file));
    const texts = files.map((file) => "\n\n# " + path.basename(file) + "\n\n" + fs.readFileSync(file, "utf8").trim());
    return [...new Set(texts)].slice(0, 2).join("");
  }

  // a request's use: its cost at list prices (none known: none), and, a
  // turn's, its context
  export function used(chat: Chat, { run, use }: Used, turn: boolean): void {
    try {
      chat.use.micros += Price.cost(run.model, use);
    } catch {}
    if (turn) {
      chat.use.context = use.input + use.read + use.write;
      chat.use.output  = use.output;
    }
    chat.hooks.state();
  }

  // the work a crash or a kill cut goes on, told so
  export function resume(chat: Chat): boolean {
    if (!chat.mem.work.includes(TURN)) {
      return false;
    }
    Local.take(chat, Local.push(chat, "note", "unii restarted, cutting Unii's turn; nothing was lost: go on."));
    return true;
  }

  // the user's message, logged and taken
  export function say(chat: Chat, text: string): Msg {
    const msg = Local.push(chat, "user", text);
    Local.take(chat, msg);
    return msg;
  }

  export function take(chat: Chat, msg: Msg): void {
    const mem = chat.mem;
    if (chat.call !== null && Memory.whole(mem, msg.id) === msg.id) {
      chat.sent.push(msg);
      chat.call.send(Memory.say(mem, msg.id, msg.end));
      return;
    }
    chat.wait.push(msg);
    if (!chat.busy) {
      Local.turn(chat);
    }
  }

  export async function turn(chat: Chat): Promise<void> {
    chat.busy = true;
    try {
      let go = true;
      while (go && chat.wait.length > 0 && !chat.closed) {
        go = await Local.call(chat);
      }
    } catch (err: any) {
      Local.failed(chat, String(err?.message ?? err));
    } finally {
      const why = chat.halt.signal.aborted ? chat.halt.signal.reason : null;
      if (typeof why === "string") {
        Local.push(chat, "note", why);
      }
      chat.call  = null;
      chat.sent  = [];
      chat.wait  = [];
      chat.busy  = false;
      chat.tool  = null;
      Local.live(chat, []);
      Local.change(chat);
    }
  }

  export function from(chat: Chat): number {
    return Memory.whole(chat.mem, chat.wait[0].id);
  }

  // false: the turn ends
  export async function call(chat: Chat): Promise<boolean> {
    const mem = chat.mem;
    const halt = (chat.halt = new AbortController());
    Local.change(chat);
    let from = -1;
    while (from !== Local.from(chat)) {
      from = Local.from(chat);
      const why = await Memory.settle(mem, from, halt.signal);
      if (why !== null) {
        if (!halt.signal.aborted) {
          Local.failed(chat, why);
        }
        return false;
      }
    }
    const msgs = (chat.sent = chat.wait.splice(0));
    const says = msgs.filter((m) => m.end > from).map((m) => Memory.say(mem, Math.max(m.id, from), m.end));
    const text = says.map((say) => say.text).join("\n\n");
    const imgs = says.flatMap((say) => say.imgs);
    const blocks = [...Memory.view(mem, from), { text: "Working directory: " + chat.cwd + "\n\n", mark: false }, { text: HEAD + text, mark: true }];
    const used = (u: Used) => Local.used(chat, u, true);
    const ask = { ...Local.share(chat), server: Local.tools(chat), blocks, imgs, used };
    const call = (chat.call = AskAI.ask(ask, (ev) => Local.on(chat, ev)));
    chat.hooks.state();
    return Local.ended(chat, call, halt);
  }

  // the turn's call ends; false: the turn ends
  export async function ended(chat: Chat, call: Call, halt: AbortController): Promise<boolean> {
    const end = await call.done;
    chat.call = null;
    chat.tool = null;
    Local.unanswered(chat);
    chat.wait.unshift(...chat.sent.slice(chat.sent.length - end.left.length));
    if (!end.ok && !halt.signal.aborted) {
      Local.failed(chat, end.text);
    }
    if (end.note) {
      chat.hooks.mind(end.note);
    }
    chat.hooks.ended(end);
    const goal = chat.mem.goal;
    if (end.ok && !halt.signal.aborted && chat.wait.length === 0 && goal !== null) {
      return Local.checked(chat, goal, halt);
    }
    return !halt.signal.aborted;
  }

  // the user's goal (/goal), asked of the chat's model, without tools, on
  // the chat as it is now: unmet, the nudge goes on as the user's message
  export async function checked(chat: Chat, goal: string, halt: AbortController): Promise<boolean> {
    const mem  = chat.mem;
    const at   = Memory.whole(mem, 0);
    const tail = Array.from({ length: mem.count - at }, (_, k) => at + k).map((i) => {
      const msg = Memory.message(mem, i)!;
      return Memory.line({ l: 0, i }, msg.kind + ": " + msg.text) + "\n";
    });
    const blocks = [...Memory.view(mem, at), { text: tail.join("") + GOAL_ASK + goal, mark: true }];
    const call = (chat.check = AskAI.ask({ ...Local.share(chat), system: GOAL, blocks }, () => {}));
    halt.signal.addEventListener("abort", () => call.stop(), { once: true });
    const end = await call.done;
    const on = !halt.signal.aborted && mem.goal === goal && chat.wait.length === 0;
    chat.check = null;
    if (on && !end.ok) {
      Local.push(chat, "note", "No goal check: " + end.text.replace(/\.$/, "") + ". The goal stays; /halt drops it.");
    } else if (on && /^\W*yes\b/i.test(end.text)) {
      mem.goal = null;
      Memory.save(mem);
      Local.push(chat, "note", "Goal met.");
    } else if (on) {
      Local.take(chat, Local.push(chat, "user", GOAL_NO));
    }
    return !halt.signal.aborted;
  }

  export function failed(chat: Chat, why: string): void {
    Local.push(chat, "note", "No reply: " + why.replace(/\.$/, "") + ". Send a message to try again.");
  }

  // to the chat, in pages, each told to the terminal
  export function push(chat: Chat, kind: Kind, text: string): Msg {
    const roots = Memory.push(chat.mem, [{ kind, text }]);
    for (const { i, kind, text, date, more } of roots) {
      chat.hooks.entry({ id: i, kind, text, date, more: more === true });
    }
    return { id: roots[0].i, end: chat.mem.count };
  }

  // a call's event: a piece streams; an entry is logged, a tool call with
  // its result (both as they came), a thought only shown
  export function on(chat: Chat, ev: Event): void {
    if (ev.$ === "Delta") {
      live_push(chat.live, ev.kind, ev.text, ev.fresh);
      chat.hooks.live(chat.live);
      return;
    }
    if (ev.kind === "tool" && ev.of !== undefined) {
      chat.calls[ev.of] = ev.text;
      chat.tool = ev.text;
    } else if (ev.kind === "mind") {
      chat.hooks.mind(ev.text);
    } else if (ev.kind !== "user") {
      const call = ev.of === undefined ? undefined : chat.calls[ev.of];
      delete chat.calls[ev.of ?? ""];
      if (call !== undefined) {
        Local.push(chat, "tool", call);
        chat.tool = null;
      }
      Local.push(chat, ev.kind, ev.text);
    }
    Local.live(chat, Object.values(chat.calls).map((text) => ({ kind: "tool", text })));
    chat.hooks.state();
  }

  // a stopped call's tool calls without a result, logged as they are
  export function unanswered(chat: Chat): void {
    const calls = Object.values(chat.calls);
    chat.calls = {};
    calls.forEach((call) => Local.push(chat, "tool", call));
    Local.live(chat, []);
  }

  export function live(chat: Chat, live: Live[]): void {
    chat.live = live;
    chat.hooks.live(live);
  }

  // the turn stops: its call, the tool it runs (its process group killed:
  // Machine.ts), its goal check; why: the note logged as it ends
  export function interrupt(chat: Chat, why: string): boolean {
    if (!chat.busy) {
      return false;
    }
    chat.halt.abort(why);
    chat.call?.stop();
    chat.check?.stop();
    return true;
  }

  // what runs saved, as it changes: a turn the next open resumes
  export function change(chat: Chat): void {
    const work = chat.busy ? [TURN] : [];
    if (!chat.closed && String(work) !== String(chat.mem.work)) {
      chat.mem.work = work;
      Memory.save(chat.mem);
    }
    chat.hooks.state();
  }

  export function repick(chat: Chat, pick: Pick): void {
    chat.pick = chat.mem.pick = pick;
    Memory.save(chat.mem);
    chat.hooks.state();
  }

  export function goal(chat: Chat, goal: string | null): void {
    chat.mem.goal = goal;
    Memory.save(chat.mem);
    if (goal === null) {
      Local.push(chat, "note", "Goal halted by the user.");
    }
    chat.hooks.state();
  }

  // the chat closes: its turn and summaries cut, its processes killed,
  // all written flushed. A turn cut so stays saved as running, so the
  // next open resumes it
  export async function close(chat: Chat): Promise<void> {
    chat.closed = true;
    chat.call?.stop();
    chat.check?.stop();
    Memory.stop(chat.mem);
    Machine.end();
    await Disk.synced();
  }

  // Tools
  // -----

  // the turn's tools, run here: the memory's, and the machine's in the
  // working dir
  export function tools(chat: Chat): Provider {
    const kit = TOOLS.map((t) => ({ ...t, info: t.info + " It runs in the working directory." }));
    const list = () => [...OWN, ...kit];
    const call = (name: string, input: unknown, signal: AbortSignal) => Local.run(chat, name, input as Record<string, unknown>, signal);
    return { list, call };
  }

  export async function run(chat: Chat, name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<Out> {
    const mem = chat.mem;
    switch (name) {
      case "zoom": {
        const id = Number(input.id);
        const n  = Number(input.n ?? 1);
        const at = Number(input.at ?? 0);
        const imgs = n === 1 && at === 0 ? Memory.images(mem, id) : [];
        return { text: Memory.zoom(mem, id, n, at), fail: false, imgs };
      }
      case "date": {
        return { text: Memory.date(mem, Number(input.id)), fail: false };
      }
      case "shell":
      case "read":
      case "write":
      case "edit": {
        return Machine.run({ name, input, cwd: path.basename(chat.cwd) }, path.dirname(chat.cwd), signal);
      }
    }
    return { text: "No tool " + name + ".", fail: true };
  }

  // Show
  // ----

  // the pages of the last `n` messages, as shown, from a message's first
  export function tail(chat: Chat, n: number): Shown[] {
    const mem = chat.mem;
    let from = Math.max(0, mem.count - n);
    while (from > 0 && Memory.message(mem, from - 1)?.more) {
      from--;
    }
    return Array.from({ length: mem.count - from }, (_, k) => Memory.message(mem, from + k)!).map(({ i, kind, text, date, more }) => ({ id: i, kind, text, date, more: more === true }));
  }

  // what the status line says of the turn: its model's call, the tool it
  // runs, the summaries it waits on, or none
  export function doing(chat: Chat): string {
    if (!chat.busy) {
      return "";
    }
    if (chat.tool !== null) {
      return "running " + chat.tool.split(" ")[0];
    }
    if (chat.check !== null) {
      return "checking the goal";
    }
    if (chat.call !== null) {
      return chat.live.length > 0 ? "writing" : "thinking";
    }
    return "summarizing earlier messages";
  }

}

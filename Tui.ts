// Tui
// ===
// The harness's interactive mode (unii.ts): one chat (Local.ts) in the
// terminal's own scrollback, as omp's interactive mode shows one. The
// frame is the chat's messages, what streams, the editor (Editor.ts), a
// menu (the slash commands matching what is typed, or a picker: models,
// efforts, sessions) and a status line (model, context, cost, what runs);
// each change draws only the lines it changed (Render.ts), at most one
// frame per FRAME ms. Esc stops the turn: its stream cut, its running
// tool's process group killed. Ctrl+O opens tool output or folds it.
// The terminal is given back as it was on any way out: a quit, a signal,
// an error no one caught.

import * as os from "node:os";
import type { Kind } from "./AskAI.ts";
import * as config from "./Config.ts";
import { S, clean, cut, message, paint, tool as tool_lines, width, wrap } from "./Draw.ts";
import { Editor } from "./Editor.ts";
import { Keys, WAIT, type Key } from "./Keys.ts";
import type { Live } from "./Live.ts";
import { Local, type Chat, type Shown } from "./Local.ts";
import { Pick } from "./Pick.ts";
import { Render } from "./Render.ts";
import { Store, type Session } from "./Store.ts";

// Types
// =====

// a message shown: its kind and text (its pages joined), its lines drawn
// for a width and fold, kept till either changes
export type Item = { id: number; kind: Kind; text: string; more: boolean; key: string; lines: string[] };

// a choice in a menu: what it shows, a word after it, its value
export type Choice = { label: string; info: string; value: string };

// a picker: its title, choices, the one marked, what is typed to filter
// them; done: the value chosen, null if none
export type Menu = { title: string; all: Choice[]; at: number; query: string; done: (value: string | null) => void };

// a slash command: its name, its argument's hint, what it does, its run
export type Cmd = { name: string; arg: string; info: string; run: (t: Tui, arg: string) => void | Promise<void> };

export type Tui = {
  chat     : Chat;
  session  : Session;
  items    : Item[];
  earlier  : number;
  live     : Live[];
  mind     : string;
  ed       : Editor;
  keys     : Keys;
  render   : Render;
  menu     : Menu | null;
  pick     : number;
  open     : boolean;
  notes    : string[];
  quit     : number;
  timer    : Timer | null;
  flush    : Timer | null;
  spin     : Timer | null;
  frame    : number;
  started  : number;
  out      : (s: string) => void;
  done     : (code: number) => void;
  closing  : boolean;
  attached : boolean;
  given    : boolean;
};

type Timer = ReturnType<typeof setTimeout>;

// Constants
// =========

// the least ms between two frames, and between two spinner steps
const FRAME = 16;
const SPIN  = 80;

// the messages a chat shows as it opens; those before stay in its memory
const TAIL = 200;

// the ms Ctrl+C's second press quits in
const QUIT = 1500;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// the menu's rows at most
const MENU_ROWS = 10;

// the terminal set and given back: bracketed paste; kitty's keys (flag 1:
// Esc and modified keys told apart); xterm's modifyOtherKeys; the cursor
// hidden (the editor draws its own)
const TERM_ON  = "\x1b[?2004h\x1b[>1u\x1b[>4;1m\x1b[?25l";
const TERM_OFF = "\x1b[<u\x1b[>4;0m\x1b[?2004l\x1b[?25h\x1b[0m";

// the vendors whose calls a plan pays (the costs shown are list prices)
const PLANS = ["codex", "opencode-go"];

export const CMDS: Cmd[] = [
  { name: "/model",  arg: "[name]",    info: "pick the model; with a name, that one",            run: (t, a) => Tui.pick_menu(t, "model", a) },
  { name: "/effort", arg: "[level]",   info: "pick the effort; with one, that one",              run: (t, a) => Tui.pick_menu(t, "effort", a) },
  { name: "/resume", arg: "",          info: "go on with another session of this directory",     run: (t) => Tui.sessions(t) },
  { name: "/new",    arg: "",          info: "start a new session here",                         run: (t) => Tui.switch_to(t, Store.make(t.session.cwd)) },
  { name: "/import", arg: "[dir]",     info: "the server's chat as a new session (~/.unii/users/1)", run: (t, a) => Tui.bring(t, a) },
  { name: "/goal",   arg: "<message>", info: "send a message as the goal: each turn's end checks it, and goes on till it is met", run: (t, a) => Tui.goal(t, a) },
  { name: "/halt",   arg: "",          info: "drop the goal",                                    run: (t) => Local.goal(t.chat, null) },
  { name: "/open",   arg: "",          info: "open tool output, or fold it again (Ctrl+O)",      run: (t) => Tui.fold(t) },
  { name: "/help",   arg: "",          info: "the commands and keys",                            run: (t) => Tui.help(t) },
  { name: "/quit",   arg: "",          info: "leave (also /exit, Ctrl+D)",                       run: (t) => Tui.leave(t) },
  { name: "/exit",   arg: "",          info: "leave",                                            run: (t) => Tui.leave(t) },
];

const KEYS_HELP = [
  "Enter sends; Shift+Enter, Alt+Enter or Ctrl+J break the line; a message sent while unii works reaches it between tool calls.",
  "Esc stops the turn (its running command killed). Ctrl+C clears what is typed; on an empty editor, twice quits. Ctrl+D quits.",
  "Up and Down: the lines, then the messages sent before. Ctrl+A/E, Ctrl+U/K/W, Alt+B/F as in a shell. Ctrl+O: tool output. Ctrl+L: redraw.",
];

// Tui
// ===

export namespace Tui {

  // the chat of `session` in the terminal till it quits; resume: the
  // sessions picker shown first. The exit code it quits with
  export function run(session: Session, opts: { resume?: boolean } = {}): Promise<number> {
    return new Promise((done) => {
      const out = (s: string) => {
        process.stdout.write(s);
      };
      const t = Tui.make(session, out, process.stdout.columns ?? 80, process.stdout.rows ?? 24, done);
      Tui.attach(t);
      if (opts.resume) {
        Tui.sessions(t);
      }
      Tui.draw(t);
    });
  }

  // the harness's state on a session, drawn to `out` at w by h (a test's
  // screen, or the terminal)
  export function make(session: Session, out: (s: string) => void, w: number, h: number, done: (code: number) => void): Tui {
    const t: Tui = {
      chat: null as unknown as Chat, session, items: [], earlier: 0, live: [], mind: "", ed: Editor.make(), keys: Keys.make(),
      render: Render.make(out, w, h), menu: null, pick: 0, open: false, notes: [], quit: 0, timer: null, flush: null, spin: null,
      frame: 0, started: 0, out, done, closing: false, attached: false, given: false,
    };
    Tui.open(t, session);
    return t;
  }

  // the terminal raw, its keys read, its size followed; given back on
  // any way out
  export function attach(t: Tui): void {
    const stdin = process.stdin;
    t.attached = true;
    stdin.setRawMode?.(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    t.out(TERM_ON);
    stdin.on("data", (chunk: string) => Tui.input(t, chunk));
    process.stdout.on("resize", () => {
      Render.resize(t.render, process.stdout.columns, process.stdout.rows);
      Tui.draw(t);
    });
    const leave = () => Tui.leave(t);
    process.on("SIGINT", leave);
    process.on("SIGTERM", leave);
    process.on("SIGHUP", leave);
    const crash = (err: unknown) => {
      Tui.restore(t);
      process.stderr.write("unii: " + String((err as any)?.stack ?? err) + "\n");
      process.exit(1);
    };
    process.on("uncaughtException", crash);
    process.on("unhandledRejection", crash);
    process.on("exit", () => Tui.restore(t));
  }

  // the terminal as it was: keys, paste, cursor, cooked mode
  export function restore(t: Tui): void {
    if (t.given) {
      return;
    }
    t.given = true;
    if (t.attached && process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {}
    }
    try {
      t.out(Render.end(t.render) + TERM_OFF);
    } catch {}
    t.render.lines = [];
    t.render.row = 0;
  }

  export function open(t: Tui, session: Session): void {
    if (!Store.lock(session.dir)) {
      session = Store.make(session.cwd);
      Store.lock(session.dir);
      t.notes.push("That session is open in another unii; this is a new one.");
    }
    t.session = session;
    t.items = [];
    t.live = [];
    t.mind = "";
    const hooks = {
      entry : (m: Shown) => Tui.entry(t, m),
      live  : (live: Live[]) => {
        t.live = live.map((l) => ({ ...l }));
        Tui.draw(t);
      },
      mind  : (text: string) => {
        t.mind = text;
        Tui.draw(t);
      },
      state : () => Tui.draw(t),
      ended : () => {
        t.mind = "";
        Tui.draw(t);
      },
    };
    t.chat = Local.open(session.dir, session.cwd, hooks);
    const shown = Local.tail(t.chat, TAIL);
    t.earlier = shown.length === 0 ? t.chat.mem.count : shown[0].id;
    shown.forEach((m) => Tui.entry(t, m, false));
    t.ed.history = t.items.filter((i) => i.kind === "user").map((i) => i.text).slice(-500);
    t.ed.back = t.ed.history.length;
    if (t.chat.mem.count === 0 && session.from === undefined && Store.chats().length > 0 && Store.list(session.cwd).every((s) => s.count === 0)) {
      t.notes.push("The server's chat can come here with its history and memory: /import.");
    }
    Local.resume(t.chat);
    Render.redraw(t.render);
  }

  // a message logged: a new item, or the page that goes on the last
  export function entry(t: Tui, m: Shown, draw = true): void {
    const top = t.items[t.items.length - 1];
    if (top !== undefined && top.more && top.kind === m.kind) {
      top.text += m.text;
      top.more = m.more;
      top.key = "";
    } else {
      t.items.push({ id: m.id, kind: m.kind, text: m.text, more: m.more, key: "", lines: [] });
    }
    if (draw) {
      Tui.draw(t);
    }
  }

  // Input
  // -----

  export function input(t: Tui, chunk: string): void {
    if (t.flush !== null) {
      clearTimeout(t.flush);
      t.flush = null;
    }
    for (const k of Keys.feed(t.keys, chunk)) {
      Tui.key(t, k);
    }
    if (Keys.waiting(t.keys)) {
      t.flush = setTimeout(() => {
        t.flush = null;
        Keys.flush(t.keys).forEach((k) => Tui.key(t, k));
      }, WAIT);
    }
  }

  export function key(t: Tui, k: Key): void {
    if (t.closing) {
      return;
    }
    const is = (name: string, mod: "ctrl" | "alt" | "" = "") => k.$ === "key" && k.name === name && (mod === "" ? !k.ctrl && !k.alt : k[mod]);
    if (is("c", "ctrl")) {
      return Tui.ctrl_c(t);
    }
    t.quit = 0;
    if (t.menu !== null) {
      return Tui.menu_key(t, k);
    }
    if (is("d", "ctrl") && t.ed.text === "") {
      return Tui.leave(t);
    }
    if (is("o", "ctrl")) {
      return Tui.fold(t);
    }
    if (is("l", "ctrl")) {
      Render.redraw(t.render);
      return Tui.draw(t);
    }
    if (is("escape")) {
      if (Tui.matches(t).length > 0 && t.ed.text !== "") {
        Editor.set(t.ed, "");
      } else if (!Local.interrupt(t.chat, "Stopped by the user.")) {
        t.notes = [];
      }
      return Tui.draw(t);
    }
    const cmds = Tui.matches(t);
    if (cmds.length > 0 && k.$ === "key" && !k.ctrl && !k.alt) {
      const at = Math.min(t.pick, cmds.length - 1);
      if (k.name === "up" || k.name === "down") {
        t.pick = (at + (k.name === "up" ? -1 : 1) + cmds.length) % cmds.length;
        return Tui.draw(t);
      }
      if (k.name === "tab") {
        Editor.set(t.ed, cmds[at].name + (cmds[at].arg === "" ? "" : " "));
        return Tui.draw(t);
      }
      if (k.name === "enter" && !k.shift && cmds[at].name !== t.ed.text.trim()) {
        Editor.set(t.ed, cmds[at].name + (cmds[at].arg.startsWith("<") ? " " : ""));
        if (cmds[at].arg.startsWith("<")) {
          return Tui.draw(t);
        }
      }
    }
    const did = Editor.key(t.ed, k, Tui.cols(t));
    if (did === "send") {
      Tui.send(t, Editor.take(t.ed));
    }
    t.pick = did === "edit" ? 0 : t.pick;
    Tui.draw(t);
  }

  export function ctrl_c(t: Tui): void {
    if (t.menu !== null) {
      const menu = t.menu;
      t.menu = null;
      menu.done(null);
    } else if (t.ed.text !== "") {
      Editor.set(t.ed, "");
      t.quit = 0;
    } else if (t.quit > 0 && Date.now() - t.quit < QUIT) {
      return Tui.leave(t);
    } else {
      t.quit = Date.now();
      t.notes = ["Ctrl+C again quits."];
    }
    Tui.draw(t);
  }

  // the message sent, or the command run
  export function send(t: Tui, text: string): void {
    t.notes = [];
    const trimmed = text.trim();
    if (trimmed === "") {
      return;
    }
    const word = /^\/[a-z]+(?=\s|$)/i.exec(trimmed)?.[0];
    if (word !== undefined) {
      const cmd = CMDS.find((c) => c.name === word.toLowerCase());
      if (cmd === undefined) {
        t.notes.push(word + " is no command; nothing was sent. /help lists them.");
        return;
      }
      Promise.resolve(cmd.run(t, trimmed.slice(word.length).trim())).catch((err) => {
        t.notes.push(String(err?.message ?? err));
        Tui.draw(t);
      });
      return;
    }
    Local.say(t.chat, text);
  }

  // the commands matching what is typed: a slash and a word, no more
  export function matches(t: Tui): Cmd[] {
    const m = /^\/[a-z]*$/i.exec(t.ed.text);
    return m === null ? [] : CMDS.filter((c) => c.name.startsWith(m[0].toLowerCase()));
  }

  export function menu_key(t: Tui, k: Key): void {
    const menu = t.menu!;
    const list = Tui.filtered(menu);
    if (k.$ === "text" || k.$ === "paste") {
      menu.query += k.x.replace(/\s+/g, " ");
      menu.at = 0;
    } else if (k.name === "escape") {
      t.menu = null;
      menu.done(null);
    } else if (k.name === "up" || k.name === "down") {
      menu.at = list.length === 0 ? 0 : (menu.at + (k.name === "up" ? -1 : 1) + list.length) % list.length;
    } else if (k.name === "backspace") {
      menu.query = menu.query.slice(0, -1);
      menu.at = 0;
    } else if (k.name === "enter") {
      const hit = list[menu.at];
      if (hit !== undefined) {
        t.menu = null;
        menu.done(hit.value);
      }
    }
    Tui.draw(t);
  }

  export function filtered(menu: Menu): Choice[] {
    const q = menu.query.toLowerCase();
    return menu.all.filter((c) => (c.label + " " + c.info).toLowerCase().includes(q));
  }

  // Commands
  // --------

  export function pick_menu(t: Tui, part: "model" | "effort", arg: string): void {
    const chat = t.chat;
    if (arg !== "") {
      const to = Pick.move(chat.pick, part, config.OFFER, arg);
      if (to === null) {
        t.notes.push("No " + part + " " + arg + ". /" + part + " lists them.");
      } else {
        Local.repick(chat, to);
      }
      return Tui.draw(t);
    }
    const all = Pick.options(chat.pick, part, config.OFFER).map(([label, p]): Choice => ({ label, info: part === "model" ? p.vendor : "", value: Pick.label(p) }));
    const at = Math.max(0, all.findIndex((c) => c.value === Pick.label(chat.pick)));
    t.menu = {
      title: part === "model" ? "Model" : "Effort", all, at, query: "",
      done: (value) => {
        const to = value === null ? null : Pick.read(Tui.parse(value), config.OFFER);
        if (to !== null) {
          Local.repick(chat, to);
        }
        Tui.draw(t);
      },
    };
    Tui.draw(t);
  }

  export function parse(label: string): Pick {
    const [vendor, model, effort, speed] = label.split(":");
    return { vendor: vendor as Pick["vendor"], model, effort, speed };
  }

  export function sessions(t: Tui): void {
    const list = Store.list(t.session.cwd).filter((s) => !s.print);
    const all = list.map((s): Choice => ({
      label: (s.last === null ? "(empty)" : cut(clean(s.last.text).replace(/\s+/g, " "), 60)),
      info: when(s.time) + " · " + s.count + " lines" + (s.from ? " · imported" : "") + (s.id === t.session.id ? " · this one" : Store.holder(s.dir) !== null ? " · open elsewhere" : ""),
      value: s.dir,
    }));
    t.menu = {
      title: "Sessions in " + home(t.session.cwd), all, at: 0, query: "",
      done: (dir) => {
        const s = dir === null ? null : Store.read(dir);
        if (s !== null && s.id !== t.session.id) {
          Tui.switch_to(t, s);
        }
        Tui.draw(t);
      },
    };
    Tui.draw(t);
  }

  // another session in this terminal: the chat open closed first
  export async function switch_to(t: Tui, s: Session): Promise<void> {
    Local.interrupt(t.chat, "Stopped: another session opened.");
    await Local.close(t.chat);
    Store.unlock(t.session.dir);
    Tui.open(t, s);
    Tui.draw(t);
  }

  export function bring(t: Tui, arg: string): Promise<void> {
    const src = arg === "" ? config.DIR + "/users/1" : arg.replace(/^~(?=\/|$)/, os.homedir());
    const s = Store.bring(src, t.session.cwd);
    t.notes.push("Imported " + src + " as a new session: " + s.count + " lines.");
    return Tui.switch_to(t, s);
  }

  export function goal(t: Tui, arg: string): void {
    if (arg === "") {
      t.notes.push("/goal needs one: /goal <message>.");
      return Tui.draw(t);
    }
    Local.goal(t.chat, arg);
    Local.say(t.chat, "/goal " + arg);
  }

  export function fold(t: Tui): void {
    t.open = !t.open;
    Render.redraw(t.render);
    Tui.draw(t);
  }

  export function help(t: Tui): void {
    const w = Math.max(...CMDS.map((c) => (c.name + " " + c.arg).length));
    t.notes = [...CMDS.map((c) => (c.name + " " + c.arg).padEnd(w + 2) + c.info), ...KEYS_HELP];
    Tui.draw(t);
  }

  // the chat closed, all written flushed, the terminal given back
  export async function leave(t: Tui, code = 0): Promise<void> {
    if (t.closing) {
      return;
    }
    t.closing = true;
    t.menu = null;
    Tui.show(t);
    [t.timer, t.flush, t.spin].forEach((x) => x !== null && clearTimeout(x));
    await Local.close(t.chat);
    Store.unlock(t.session.dir);
    Tui.restore(t);
    if (t.attached) {
      process.stdin.pause();
    }
    t.done(code);
  }

  // Draw
  // ----

  export function cols(t: Tui): number {
    return Math.max(10, t.render.w - 1);
  }

  // a frame soon: at most one each FRAME ms
  export function draw(t: Tui): void {
    if (t.timer === null && !t.closing) {
      t.timer = setTimeout(() => {
        t.timer = null;
        Tui.show(t);
      }, FRAME);
    }
  }

  export function show(t: Tui): void {
    Render.draw(t.render, Tui.frame_lines(t));
    const busy = t.chat.busy;
    if (busy && t.spin === null && !t.closing) {
      t.started = t.started || Date.now();
      t.spin = setTimeout(() => {
        t.spin = null;
        t.frame++;
        Tui.draw(t);
      }, SPIN);
    }
    if (!busy) {
      t.started = 0;
    }
  }

  // the frame's lines
  export function frame_lines(t: Tui): string[] {
    const w = Tui.cols(t);
    const out: string[] = [];
    out.push(paint_dim("unii · " + home(t.session.cwd) + " · session " + t.session.id + (t.earlier > 0 ? " · " + t.earlier + " earlier lines in its memory" : ""), w));
    out.push("");
    for (const [k, item] of t.items.entries()) {
      const next = t.items[k + 1];
      // a call logged has its result next, but one a stop cut
      const state = item.kind !== "tool" ? "" : next?.kind === "echo" && !next.text.startsWith("error: ") ? "done" : "failed";
      const key = w + ":" + t.open + ":" + state;
      if (item.key !== key) {
        item.lines = item.kind === "tool" ? tool_lines(item.text, w, t.open, state as "done" | "failed") : message(item.kind, item.text, w, t.open);
        item.key = key;
      }
      out.push(...item.lines);
      if (!(item.kind === "tool" && next?.kind === "echo")) {
        out.push("");
      }
    }
    for (const l of t.live) {
      out.push(...(l.kind === "tool" ? tool_lines(l.text, w, false, "running") : l.kind === "mind" ? mind_lines(l.text, w) : message(l.kind, l.text, w, false)));
    }
    if (t.live.length > 0) {
      out.push("");
    }
    if (t.chat.busy) {
      if (t.mind !== "") {
        out.push(...mind_lines(t.mind, w));
      }
      const secs = Math.floor((Date.now() - (t.started || Date.now())) / 1000);
      out.push(paint([[SPINNER[t.frame % SPINNER.length] + " ", S.cyan], [Local.doing(t.chat) + "… " + secs + "s", S.none], ["  (esc to stop)", S.dim]]));
    }
    for (const note of t.notes) {
      out.push(...wrap([[note, S.yell]], w));
    }
    out.push(paint([["─".repeat(w), S.dim]]));
    out.push(...Editor.draw(t.ed, w, t.chat.busy ? "message unii as it works" : "message unii, / for commands"));
    out.push(...Tui.menu_lines(t, w));
    out.push(Tui.status(t, w));
    return out;
  }

  export function menu_lines(t: Tui, w: number): string[] {
    if (t.menu !== null) {
      const menu = t.menu;
      const list = Tui.filtered(menu);
      const top = Math.max(0, Math.min(menu.at - Math.floor(MENU_ROWS / 2), list.length - MENU_ROWS));
      const head = paint([[menu.title, S.bold], [menu.query === "" ? "  type to filter · enter picks · esc closes" : "  " + menu.query, S.dim]]);
      const rows = list.slice(top, top + MENU_ROWS).map((c, k) => choice_line(c, top + k === menu.at, w));
      return [head, ...rows, ...(list.length === 0 ? [paint([["  (none)", S.dim]])] : [])];
    }
    const cmds = Tui.matches(t);
    const at = Math.min(t.pick, cmds.length - 1);
    return cmds.slice(0, MENU_ROWS).map((c, k) => choice_line({ label: c.name + (c.arg ? " " + c.arg : ""), info: c.info, value: c.name }, k === at, w));
  }

  // model · effort · context · cost · where · goal
  export function status(t: Tui, w: number): string {
    const chat = t.chat;
    const use = chat.use;
    const plan = PLANS.includes(chat.pick.vendor);
    const parts = [
      chat.pick.model + " " + chat.pick.effort + (chat.pick.speed === "slow" ? "" : " " + chat.pick.speed),
      "ctx " + tokens(use.context),
      "≈$" + (use.micros / 1e6).toFixed(2) + (plan ? " (plan)" : ""),
      home(chat.cwd),
      ...(chat.mem.goal === null ? [] : ["goal: " + chat.mem.goal]),
    ];
    return paint([[cut(parts.join(" · "), w), S.dim]]);
  }

}

// Helpers
// =======

function paint_dim(s: string, w: number): string {
  return paint([[cut(s, w), S.dim]]);
}

function mind_lines(text: string, w: number): string[] {
  const last = clean(text).trim().split("\n").filter((l) => l.trim() !== "").slice(-2);
  return last.map((l) => paint([[cut("  " + l, w), S.ital]]));
}

function choice_line(c: Choice, on: boolean, w: number): string {
  const label = (on ? "› " : "  ") + c.label;
  const info = c.info === "" ? "" : "  " + c.info;
  const text = cut(label + info, w);
  const cut_label = text.slice(0, Math.min(text.length, label.length));
  return paint([[cut_label, on ? S.cyan : S.none], [text.slice(cut_label.length), S.dim]]);
}

function tokens(n: number): string {
  return n < 1000 ? String(n) : (n / 1000).toFixed(1) + "k";
}

function home(p: string): string {
  const h = os.homedir();
  return p === h ? "~" : p.startsWith(h + "/") ? "~" + p.slice(h.length) : p;
}

function when(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

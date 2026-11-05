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
// an error no one caught. What the user's input runs and fails is a note
// in a chat that goes on, its stack in errors.log (Tui.attempt); only what
// escapes that is fatal.

import * as fs from "node:fs";
import * as os from "node:os";
import type { Kind } from "./AskAI.ts";
import * as config from "./Config.ts";
import { S, clean, cut, message, paint, tool as tool_lines, width, wrap } from "./Draw.ts";
import { Editor } from "./Editor.ts";
import { Keys, WAIT, type Key } from "./Keys.ts";
import type { Live } from "./Live.ts";
import { Local, type Chat, type Shown } from "./Local.ts";
import { Login, type Flow, type Provider } from "./Login.ts";
import { Machine } from "./Machine.ts";
import { Damaged, Memory } from "./Memory.ts";
import { Pick, type Model } from "./Pick.ts";
import { Price } from "./Price.ts";
import { Render } from "./Render.ts";
import { Store, type Session } from "./Store.ts";

// Types
// =====

// a message shown: its kind and text (its pages joined), its lines drawn
// for a width and fold, kept till either changes
export type Item = { id: number; kind: Kind; text: string; more: boolean; key: string; lines: string[] };

// a choice in a menu: what it shows, a word after it, its value; right:
// its columns, drawn at the right edge (a model's price and context); now:
// the one in use; detail: a line under the list, of the one marked;
// group: the vendor it is listed under, in a picker's panel; columns: its
// facts, right-aligned; warn: what is wrong with picking it
export type Choice = { label: string; info: string; value: string; right?: string; now?: boolean; detail?: string; group?: string; columns?: string[]; warn?: string };

// a picker: its title, choices, the one marked, what is typed to filter
// them; done: the value chosen, null if none; panel: it takes the editor's
// place (a model selector) instead of listing under it
export type Menu = { title: string; all: Choice[]; at: number; query: string; done: (value: string | null) => void | Promise<void>; panel?: boolean };

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
  login    : { id: Provider; flow: Flow } | null;
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
  switching: Promise<void> | null;
};

type Timer = ReturnType<typeof setTimeout>;

// a session's chat open and read, not yet what the terminal shows; session:
// a new one, if another unii held the one asked for
type Opened = { session: Session; chat: Chat; shown: Shown[]; notes: string[] };

// how the terminal starts on a session: chosen: unii chose it, not the user;
// resume: the sessions picker comes first
type Start = { chosen?: boolean; resume?: boolean };

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

// what a switch says of the turn it stopped, in the old log and on the new screen
const STOPPED = "Stopped: another session opened.";

// the vendors whose calls a plan pays (the costs shown are list prices)
const PLANS = ["codex", "opencode-go"];

export const CMDS: Cmd[] = [
  { name: "/login",  arg: "[provider]", info: "sign in: ChatGPT/codex, OpenCode Go",            run: (t, a) => Tui.login(t, a) },
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

// the terminal's size in columns and rows, the last resort 80 by 24
// (a pty with no window size told, as under `script`, says 0)
export function size(): { w: number; h: number } {
  return { w: process.stdout.columns || 80, h: process.stdout.rows || 24 };
}

// Tui
// ===

export namespace Tui {

  // the chat of `session` in the terminal till it quits; resume: the
  // sessions picker shown first; chosen: as in Tui.make. The exit code it
  // quits with
  export function run(session: Session, opts: Start = {}): Promise<number> {
    return new Promise((done) => {
      const out = (s: string) => {
        process.stdout.write(s);
      };
      const t = Tui.make(session, out, size().w, size().h, done, opts);
      Tui.attach(t);
      if (opts.resume) {
        Tui.sessions(t, true);
      }
      Tui.draw(t);
    });
  }

  // the harness's state on a session, drawn to `out` at w by h (a test's
  // screen, or the terminal). chosen: a session that won't open gives way to
  // a new one, its files kept, as the user didn't ask for it. resume: a turn a
  // crash cut waits for the picker (Tui.sessions)
  export function make(session: Session, out: (s: string) => void, w: number, h: number, done: (code: number) => void, opts: Start = {}): Tui {
    const t: Tui = {
      chat: null as unknown as Chat, session, items: [], earlier: 0, live: [], mind: "", ed: Editor.make(), keys: Keys.make(),
      render: Render.make(out, w, h), menu: null, login: null, pick: 0, open: false, notes: [], quit: 0, timer: null, flush: null, spin: null,
      frame: 0, started: 0, out, done, closing: false, attached: false, given: false, switching: null,
    };
    let opened: Opened;
    try {
      opened = Tui.open(t, session);
    } catch (err: any) {
      if (!opts.chosen) {
        throw err;
      }
      Store.log_error(err);
      const fresh = Store.make(session.cwd);
      try {
        opened = Tui.open(t, fresh);
      } catch (failed) {
        Store.drop(fresh.dir);
        throw failed;
      }
      opened.notes.push(String(err?.message ?? err), "This is a new session; /resume lists the others.");
    }
    Tui.enter(t, opened, opts.resume);
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
      Render.resize(t.render, size().w, size().h);
      Tui.draw(t);
    });
    const leave = () => Tui.leave(t);
    process.on("SIGINT", leave);
    process.on("SIGTERM", leave);
    process.on("SIGHUP", leave);
    const crash = (err: unknown) => {
      Tui.restore(t);
      process.stderr.write("unii: " + String((err as any)?.stack ?? err) + "\n");
      Store.log_error(err);
      // after the terminal and the stack: a failure here costs neither
      try {
        Machine.end();
      } catch (failed) {
        process.stderr.write("unii: tools may still run: " + String(failed) + "\n");
      }
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

  // a session's chat opened and read, the chat on screen untouched: a
  // session that won't open fails here, held by no one
  export function open(t: Tui, session: Session): Opened {
    let chat: Chat | null = null;
    // a closed chat's turn may end after the next chat is on screen: what
    // it writes stays in its log. Before enter only draws fire, and a draw follows it
    const own = <A extends unknown[]>(hook: (...a: A) => void) => (...a: A) => {
      if (t.chat === chat) {
        hook(...a);
      }
    };
    const hooks = {
      entry : own((m: Shown) => Tui.entry(t, m)),
      live  : own((live: Live[]) => {
        t.live = live.map((l) => ({ ...l }));
        Tui.draw(t);
      }),
      mind  : own((text: string) => {
        t.mind = text;
        Tui.draw(t);
      }),
      state : own(() => Tui.draw(t)),
      ended : own(() => {
        t.mind = "";
        Tui.draw(t);
      }),
      fault : own((why: string) => Tui.note(t, why)),
      summary : () => {},
    };
    const notes: string[] = [];
    try {
      if (!Store.lock(session.dir)) {
        session = Store.make(session.cwd);
        Store.lock(session.dir);
        notes.push("That session is open in another unii; this is a new one.");
      }
      chat = Local.open(session.dir, session.cwd, hooks);
      return { session, chat, shown: Local.tail(chat, TAIL), notes };
    } catch (err: any) {
      if (chat !== null) {
        Memory.stop(chat.mem);
      }
      Store.unlock(session.dir);
      const opened = "Session " + session.id + " can't be opened: ";
      if (err instanceof Damaged) {
        throw new Error(opened + "its files are damaged: " + err.message, { cause: err });
      }
      if (Store.system(err)) {
        throw new Error(opened + err.message, { cause: err });
      }
      throw err;
    }
  }

  // a chat opened, on screen; a turn a crash cut goes on, unless held
  export function enter(t: Tui, { session, chat, shown, notes }: Opened, hold = false): void {
    t.session = session;
    t.chat = chat;
    t.items = [];
    t.live = [];
    t.mind = "";
    t.notes.push(...notes);
    t.earlier = shown.length === 0 ? t.chat.mem.count : shown[0].id;
    shown.forEach((m) => Tui.entry(t, m, false));
    t.ed.history = t.items.filter((i) => i.kind === "user").map((i) => i.text).slice(-500);
    t.ed.back = t.ed.history.length;
    if (t.chat.mem.count === 0 && session.from === undefined && Store.chats().length > 0 && Store.list(session.cwd).every((s) => s.count === 0)) {
      t.notes.push("The server's chat can come here with its history and memory: /import.");
    }
    if (!hold) {
      Local.resume(t.chat);
    }
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
      Tui.attempt(t, () => Tui.key(t, k));
    }
    if (Keys.waiting(t.keys)) {
      t.flush = setTimeout(() => {
        t.flush = null;
        Keys.flush(t.keys).forEach((k) => Tui.attempt(t, () => Tui.key(t, k)));
      }, WAIT);
    }
  }

  // what a key runs: what it throws or rejects with, as a bad path or a
  // failing disk, is a note, and logged; a code bug's note says so. Leaving
  // has no chat to note it in: that stays fatal, as an unhandled rejection
  // (Tui.attach)
  export function attempt(t: Tui, run: () => void | Promise<void>): void {
    new Promise<void>((ok) => ok(run())).catch((err) => {
      const text = Store.report(err);
      if (t.closing) {
        throw err;
      }
      Tui.note(t, text);
    });
  }

  export function note(t: Tui, text: string): void {
    t.notes.push(text);
    Tui.draw(t);
  }

  export function key(t: Tui, k: Key): void | Promise<void> {
    if (t.closing) {
      return;
    }
    if (t.switching !== null) {
      return t.switching.then(() => Tui.key(t, k));
    }
    const is = (name: string, mod: "ctrl" | "alt" | "" = "") => k.$ === "key" && k.name === name && (mod === "" ? !k.ctrl && !k.alt : k[mod]);
    if (is("c", "ctrl")) {
      return Tui.ctrl_c(t);
    }
    t.quit = 0;
    if (t.menu !== null) {
      return Tui.menu_key(t, k);
    }
    if (t.login !== null && is("escape")) {
      t.login = null;
      t.notes = ["Sign-in cancelled."];
      return Tui.draw(t);
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
    t.pick = did === "edit" ? 0 : t.pick;
    Tui.draw(t);
    if (did === "send") {
      const text = Editor.take(t.ed);
      return t.login === null ? Tui.send(t, text) : Tui.login_submit(t, text);
    }
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
  export function send(t: Tui, text: string): void | Promise<void> {
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
      return cmd.run(t, trimmed.slice(word.length).trim());
    }
    const count = t.chat.mem.count;
    try {
      Local.say(t.chat, text);
    } catch (err) {
      // logged before what threw: back in the editor, Enter would send it twice
      if (t.chat.mem.count === count) {
        Editor.set(t.ed, text);
      }
      throw err;
    }
  }

  // the commands matching what is typed: a slash and a word, no more
  export function matches(t: Tui): Cmd[] {
    const m = /^\/[a-z]*$/i.exec(t.ed.text);
    return m === null ? [] : CMDS.filter((c) => c.name.startsWith(m[0].toLowerCase()));
  }

  export function menu_key(t: Tui, k: Key): void | Promise<void> {
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
        Tui.draw(t);
        return menu.done(hit.value);
      }
    }
    Tui.draw(t);
  }

  export function filtered(menu: Menu): Choice[] {
    const q = menu.query.toLowerCase();
    return menu.all.filter((c) => (c.label + " " + c.info + " " + (c.group ?? "")).toLowerCase().includes(q));
  }

  // Sign-in
  // -------

  // /login: the providers to sign in to, those already signed in saying so;
  // with an argument, the one whose id (or name) it names
  export function login(t: Tui, arg: string): void {
    if (t.login !== null) {
      t.notes = ["A sign-in is already open: paste what it asks for, or Esc."];
      return Tui.draw(t);
    }
    if (arg !== "") {
      const q = arg.toLowerCase();
      const hit = Login.PROVIDERS.find((p) => p.id.includes(q)) ?? Login.PROVIDERS.find((p) => p.name.toLowerCase().includes(q));
      if (hit === undefined) {
        t.notes = ["No provider " + arg + ": /login lists them."];
        return Tui.draw(t);
      }
      return Tui.sign_in(t, hit.id);
    }
    const all = Login.PROVIDERS.map((p): Choice => ({
      label    : p.id,
      info     : p.name,
      right    : Login.signed(p.id) ? "signed in" : "",
      now      : Login.signed(p.id),
      detail   : Login.signed(p.id) ? "Signed in as " + Login.who(p.id) + ". Choosing it again signs in anew." : p.hint + ".",
      value    : p.id,
    }));
    t.menu = {
      title: "Sign in", all, at: Math.max(0, all.findIndex((c) => c.now === true)), query: "",
      done: (value) => {
        if (value !== null) {
          Tui.sign_in(t, value as Provider);
        }
        Tui.draw(t);
      },
    };
    Tui.draw(t);
  }

  // a provider's sign-in started: its page opened where there is one and
  // its URL in a note; Enter sends what is pasted to it
  export function sign_in(t: Tui, id: Provider): void {
    const spec = Login.PROVIDERS.find((p) => p.id === id)!;
    const flow = Login.begin(id);
    t.login = { id, flow };
    const opened = Login.browse(flow.url);
    t.notes = [
      "Sign in to " + spec.name + ": " + (opened ? "the browser opened " : "open ") + flow.url,
      flow.prompt + ", then press Enter. Esc cancels.",
    ];
    Tui.draw(t);
  }

  // what was pasted for the open sign-in, sent to it: a token kept, the
  // vendor offered from now on (Config.ts), a note saying whose it is
  export function login_submit(t: Tui, text: string): void | Promise<void> {
    const login = t.login;
    if (login === null || text.trim() === "") {
      return;
    }
    const spec = Login.PROVIDERS.find((p) => p.id === login.id)!;
    t.notes = ["Signing in to " + spec.name + "…"];
    Tui.draw(t);
    return login.flow.submit(text).then(() => {
      if (t.login !== login) {
        return;
      }
      t.login = null;
      config.config_offer(Login.vendor(login.id));
      t.notes = ["Signed in to " + spec.name + " as " + Login.who(login.id) + ". /model lists its models."];
      Tui.draw(t);
    }, (err) => {
      if (t.login !== login) {
        return;
      }
      t.notes = [String((err as any)?.message ?? err), "Paste it again, or Esc to cancel."];
      Tui.draw(t);
    });
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
    const all = Pick.options(chat.pick, part, config.OFFER).map(([label, p]): Choice => {
      if (part === "effort") {
        return { label, info: "", value: Pick.label(p) };
      }
      const model = Pick.model(p.vendor, p.model);
      return {
        label,
        info   : p.vendor,
        group  : p.vendor,
        columns: model === undefined ? [] : [context(model), price(model)],
        now    : Pick.label(p) === Pick.label(chat.pick),
        detail : model === undefined ? "" : detail(model),
        warn   : model !== undefined && chat.use.context > model.ctx ? "This chat is over its " + context(model) + " context: picking this model compacts it." : "",
        value  : Pick.label(p),
      };
    });
    const at = Math.max(0, all.findIndex((c) => c.value === Pick.label(chat.pick)));
    t.menu = {
      title: part === "model" ? "Models" : "Effort", all, at, query: "", panel: true,
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

  // held: this chat's cut turn was held for this picker (Tui.enter). It goes
  // on unless the picker leaves this chat; another session's opening leaves
  // it saved for when this one opens again
  export function sessions(t: Tui, held = false): void {
    const chat = t.chat;
    const go_on = () => {
      if (held && !chat.closed) {
        Local.resume(chat);
      }
    };
    const list = Store.list(t.session.cwd).filter((s) => !s.print);
    const all = list.map((s): Choice => ({
      label: (s.last === null ? "(empty)" : cut(clean(s.last.text).replace(/\s+/g, " "), 60)),
      info: when(s.time) + " · " + s.count + " lines" + (s.from ? " · imported" : "") + (s.id === t.session.id ? " · this one" : Store.holder(s.dir) !== null ? " · open elsewhere" : ""),
      value: s.dir,
    }));
    t.menu = {
      title: "Sessions in " + Store.tilde(t.session.cwd), all, at: 0, query: "",
      done: (dir) => {
        const s = dir === null ? null : Store.read(dir);
        if (s !== null && s.id !== t.session.id) {
          return Tui.switch_to(t, s).catch((err) => {
            go_on();
            throw err;
          });
        }
        go_on();
        Tui.draw(t);
      },
    };
    Tui.draw(t);
  }

  // another session in this terminal: it opens first, so one that won't
  // leaves this chat as it was; this chat closes before the new one's turn
  // goes on, as closing kills every tool this process runs (Machine.end).
  // Keys wait till it is on screen (Tui.key); a failure reaches the caller
  export async function switch_to(t: Tui, s: Session): Promise<void> {
    const next = Tui.open(t, s);
    const busy = Local.interrupt(t.chat, STOPPED);
    const run = Tui.swap(t, next, busy);
    const free = () => {
      t.switching = null;
    };
    t.switching = run.then(free, free);
    return run;
  }

  // this chat closed and the next on screen, even if the close fails; a
  // quit meanwhile (Tui.leave) has it closed instead
  export async function swap(t: Tui, next: Opened, busy: boolean): Promise<void> {
    try {
      await Local.close(t.chat);
    } finally {
      Store.unlock(t.session.dir);
      if (t.closing) {
        await Local.close(next.chat).finally(() => Store.unlock(next.session.dir));
      } else {
        Tui.enter(t, next);
        if (busy) {
          t.notes.push(STOPPED);
        }
        Tui.draw(t);
      }
    }
  }

  export async function bring(t: Tui, arg: string): Promise<void> {
    const src = arg === "" ? config.DIR + "/users/1" : arg.replace(/^~(?=\/|$)/, os.homedir());
    const s = Store.bring(src, t.session.cwd);
    try {
      await Tui.switch_to(t, s);
    } catch (err) {
      if (t.session.id !== s.id) {
        Store.drop(s.dir);
      }
      throw err;
    }
    Tui.note(t, "Imported " + src + " as a new session: " + t.chat.mem.count + " lines.");
  }

  export function goal(t: Tui, arg: string): void {
    if (arg === "") {
      t.notes.push("/goal needs one: /goal <message>.");
      return Tui.draw(t);
    }
    // the message first: one that can't be logged leaves no goal to check.
    // Both run before the turn's first wait, so its check sees the goal
    Local.say(t.chat, "/goal " + arg);
    Local.goal(t.chat, arg);
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
    await t.switching;
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
    out.push(paint_dim("unii · " + Store.tilde(t.session.cwd) + " · session " + t.session.id + (t.earlier > 0 ? " · " + t.earlier + " earlier lines in its memory" : ""), w));
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
      const status = cut(Local.doing(t.chat) + "… " + secs + "s", w - 3);
      out.push(paint([[SPINNER[t.frame % SPINNER.length] + " ", S.cyan], [status, S.none], [width(status) + 18 < w ? "  (esc to stop)" : "", S.dim]]));
      const why = clean(Local.stuck(t.chat)).trim().split("\n")[0];
      if (why !== "") {
        out.push(paint([[cut("  failed, trying again: " + why, w - 1), S.yell]]));
      }
    }
    for (const note of t.notes) {
      out.push(...wrap([[note, S.yell]], w));
    }
    out.push(paint([["─".repeat(w), S.dim]]));
    if (t.menu !== null && t.menu.panel === true) {
      out.push(...Tui.panel_lines(t, w));
    } else {
      out.push(...Editor.draw(t.ed, w, t.login !== null ? (Login.PROVIDERS.find((p) => p.id === t.login!.id)!.kind === "key" ? "paste the key here" : "paste the code here") : t.chat.busy ? "message unii as it works" : "message unii, / for commands"));
      out.push(...Tui.menu_lines(t, w));
    }
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
      const out = [head, ...rows, ...(list.length === 0 ? [paint([["  (none)", S.dim]])] : [])];
      const below = list[menu.at]?.detail;
      if (below !== undefined && below !== "") {
        out.push("", ...wrap([[below, S.dim]], w));
      }
      return out;
    }
    const cmds = Tui.matches(t);
    const at = Math.min(t.pick, cmds.length - 1);
    return cmds.slice(0, MENU_ROWS).map((c, k) => choice_line({ label: c.name + (c.arg ? " " + c.arg : ""), info: c.info, value: c.name }, k === at, w));
  }

  // a picker that takes the editor's place, as omp's selector: its title
  // and how much it offers, the filter typed into it, its choices under
  // the vendor that runs them with their facts at the right, the marked
  // one's details under a rule, and the keys
  export function panel_lines(t: Tui, w: number): string[] {
    const menu = t.menu!;
    const list = Tui.filtered(menu);
    const vendors = new Set(list.map((c) => c.group ?? "").filter((g) => g !== ""));
    const total = menu.all.length;
    const label = list.length === total ? total + (total === 1 ? " model" : " models") : list.length + " of " + total + " models";
    const count = label + (vendors.size > 1 ? " · " + vendors.size + " vendors" : "");
    const title = cut(menu.title, w);
    const left = paint([[title, S.bold]]);
    const tail = cut(count, Math.max(0, w - width(title)));
    const out = [left + " ".repeat(Math.max(0, w - width(title) - width(tail))) + paint([[tail, S.dim]])];
    const typed = menu.query === "" ? [["type to filter", S.dim] as Run] : [[cut(menu.query, Math.max(1, w - 8)), S.none] as Run];
    out.push(paint([["  ⌕ ", S.dim], ...typed, ["▏", S.cyan]]));
    out.push(paint([["─".repeat(w), S.dim]]));
    if (list.length === 0) {
      out.push(paint([["  (none)", S.dim]]));
    }
    const top = Math.max(0, Math.min(menu.at - Math.floor(MENU_ROWS / 2), list.length - MENU_ROWS));
    const shown = list.slice(top, top + MENU_ROWS);
    const cols = shown.map((c) => c.columns ?? []);
    const one = Math.max(0, ...cols.map((r) => width(r[0] ?? "")));
    const two = Math.max(0, ...cols.map((r) => width(r[1] ?? "")));
    const price = w >= 64 && cols.some((r) => r[1] !== undefined);
    if (one > 0) {
      const caps = right_of("Ctx", one) + (price ? "  " + right_of("$/M", two) : "");
      out.push(paint([[" ".repeat(Math.max(0, w - width(caps))) + caps, S.dim]]));
    }
    let group = "";
    for (const [k, c] of shown.entries()) {
      const g = c.group ?? "";
      if (g !== "" && g !== group) {
        out.push(paint([["  " + g, S.cyan]]));
        group = g;
      }
      const at = top + k === menu.at;
      const row = (at ? "  ❯ " : "    ") + c.label + (c.now === true ? " ✓" : "");
      const facts = c.columns ?? [];
      let right = facts.length === 0 ? "" : right_of(facts[0] ?? "", one);
      if (right !== "" && price && facts[1] !== undefined) {
        right += "  " + right_of(facts[1], two);
      }
      if (w < 44) {
        right = "";
      }
      const room = Math.max(1, w - (right === "" ? 0 : width(right) + 1));
      const line = cut(row, room);
      const gap = " ".repeat(Math.max(0, w - width(line) - width(right)));
      out.push(paint([[line, at ? S.bold : S.none], [gap, S.none], [right, S.dim]]));
    }
    out.push(paint([["─".repeat(w), S.dim]]));
    const marked = list[menu.at];
    if (marked !== undefined) {
      if (marked.detail !== undefined && marked.detail !== "") {
        out.push(...wrap([[marked.detail, S.dim]], w, [["  ", S.none]], [["  ", S.none]]));
      }
      if (marked.warn !== undefined && marked.warn !== "") {
        out.push(...wrap([[marked.warn, S.yell]], w, [["  ", S.none]], [["  ", S.none]]));
      }
    }
    out.push(paint([["  ↑↓ move · type to filter · enter picks · esc closes", S.dim]]));
    return out;
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
      Store.tilde(chat.cwd),
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
  const label = (on ? "› " : "  ") + c.label + (c.now === true ? " ✓" : "");
  const left  = label + (c.info === "" ? "" : "  " + c.info);
  const right = c.right !== undefined && width(c.right) + 4 < w ? c.right : "";
  const room  = Math.max(1, w - (right === "" ? 0 : width(right) + 2));
  const text  = cut(left, room);
  const line  = right === "" ? text : text + " ".repeat(Math.max(1, room - width(text))) + right;
  const head  = text.slice(0, Math.min(label.length, text.length));
  return paint([[head, on ? S.cyan : S.none], [line.slice(head.length), S.dim]]);
}

// a model's price pair at list prices (per M tokens, "included" when
// only a plan runs it), its column at the right of the list
function price(m: Model): string {
  const rate = Price.rate(m.id);
  return rate === undefined ? "included" : "$" + number(rate.input) + "·" + number(rate.output);
}

// a column's text at the right of a cell n wide
function right_of(s: string, n: number): string {
  return " ".repeat(Math.max(0, n - width(s))) + s;
}

// a model's line under the list: what it is called, its context window and
// its list prices, and the speeds its vendor runs it at
function detail(m: Model): string {
  const rate = Price.rate(m.id);
  const price = rate === undefined
    ? "included in the plan"
    : "$" + number(rate.input) + " in · $" + number(rate.output) + " out" + (rate.read > 0 ? " · $" + number(rate.read) + " cache" : "") + " per M tokens";
  return [m.id, context(m) + " ctx", price, "speeds " + m.speeds.join(", ")].join(" · ");
}

function context(m: Model): string {
  const k = m.ctx / 1000;
  return k >= 1000 ? number(k / 1000) + "M" : number(k) + "k";
}

function number(n: number): string {
  return String(Number(n.toFixed(2)));
}

function tokens(n: number): string {
  return n < 1000 ? String(n) : (n / 1000).toFixed(1) + "k";
}

function when(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

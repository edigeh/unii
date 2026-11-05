// Tui test
// ========
// `bun test Tui.test.ts`. The terminal side of the harness, on a stubbed
// wire (wire.stub.ts) and a stubbed terminal (term.stub.ts): keys read
// from chunks cut anywhere, a paste whole; the editor's keys; the
// renderer's frames, drawn by their changes only, match the frame on the
// screen and in the scrollback, a resize too; the whole interactive mode:
// a 200-line paste goes as one message, Esc stops a reply, a resize mid
// stream leaves every row whole; what the user's input runs and fails, a
// bad path, a failing disk, a damaged session, a code bug, is a note in a
// chat that goes on, its stack in errors.log, the command without effect,
// a message back in the editor; a switch of session while a reply runs, or
// typed over.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { DIR } from "./scratch.stub.ts";

const { Keys, WAIT } = await import("./Keys.ts");
const { Editor } = await import("./Editor.ts");
const { Render } = await import("./Render.ts");
const { Tui, size } = await import("./Tui.ts");
const { Store } = await import("./Store.ts");
const { Local } = await import("./Local.ts");
const { Memory } = await import("./Memory.ts");
const { STUB, stub_install, stub_remove } = await import("./wire.stub.ts");
const { term_make, term_write, term_screen, term_all, plain } = await import("./term.stub.ts");
const { width } = await import("./Draw.ts");

type Key = import("./Keys.ts").Key;

const CWD = fs.realpathSync(fs.mkdtempSync(os.tmpdir() + "/unii-tui-cwd-"));
const LOG = DIR + "/errors.log";

beforeAll(stub_install);
afterAll(stub_remove);

function cuts(s: string, seed: number): string[] {
  const out: string[] = [];
  let x = seed;
  let i = 0;
  while (i < s.length) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const n = 1 + (x % 37);
    out.push(s.slice(i, i + n));
    i += n;
  }
  return out;
}

async function until(ok: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) {
    await Bun.sleep(10);
  }
}

describe("keys", () => {
  test("a 200-line paste cut in chunks anywhere is one paste", () => {
    const body = Array.from({ length: 200 }, (_, k) => "line " + k + " \x1b[120u").join("\r\n");
    for (const seed of [1, 7, 99]) {
      const keys = Keys.make();
      const got: Key[] = [];
      for (const chunk of cuts("ab\x1b[200~" + body + "\x1b[201~\r", seed)) {
        got.push(...Keys.feed(keys, chunk));
      }
      expect(got.filter((k) => k.$ === "text").map((k) => (k as { x: string }).x).join("")).toBe("ab");
      expect(got.filter((k) => k.$ === "paste").length).toBe(1);
      expect(got.at(-1)).toMatchObject({ $: "key", name: "enter" });
      const paste = got.find((k) => k.$ === "paste") as { x: string };
      expect(paste.x.split("\n").length).toBe(200);
      expect(paste.x).toContain("line 3 x\nline 4 x");
      expect(paste.x).not.toContain("\x1b");
      expect(paste.x).not.toContain("\r");
    }
  });

  test("Esc alone after a pause; sequences by kind", () => {
    const keys = Keys.make();
    expect(Keys.feed(keys, "\x1b")).toEqual([]);
    expect(Keys.waiting(keys)).toBe(true);
    expect(Keys.flush(keys)).toEqual([{ $: "key", name: "escape", ctrl: false, alt: false, shift: false }]);
    const read = (s: string) => Keys.feed(Keys.make(), s)[0] as any;
    expect(read("\x1b[13;2u")).toMatchObject({ name: "enter", shift: true });
    expect(read("\x1b[27;2;13~")).toMatchObject({ name: "enter", shift: true });
    expect(read("\x1b\r")).toMatchObject({ name: "enter", alt: true });
    expect(read("\x1b[99;5u")).toMatchObject({ name: "c", ctrl: true });
    expect(read("\x03")).toMatchObject({ name: "c", ctrl: true });
    expect(read("\x1b[27u")).toMatchObject({ name: "escape" });
    expect(read("\x1b[1;5D")).toMatchObject({ name: "left", ctrl: true });
    expect(read("\x1bb")).toMatchObject({ name: "b", alt: true });
    expect(read("\x1b[Z")).toMatchObject({ name: "tab", shift: true });
    expect(read("\x1bOA")).toMatchObject({ name: "up" });
    expect(read("héllo 👋")).toEqual({ $: "text", x: "héllo 👋" });
  });
});

describe("editor", () => {
  const k = (name: string, mod: Partial<{ ctrl: boolean; alt: boolean; shift: boolean }> = {}): Key => ({ $: "key", name, ctrl: false, alt: false, shift: false, ...mod });

  test("lines, words, history", () => {
    const ed = Editor.make();
    Editor.key(ed, { $: "text", x: "one two" }, 80);
    Editor.key(ed, k("enter", { shift: true }), 80);
    Editor.key(ed, { $: "text", x: "three" }, 80);
    expect(ed.text).toBe("one two\nthree");
    Editor.key(ed, k("w", { ctrl: true }), 80);
    expect(ed.text).toBe("one two\n");
    Editor.key(ed, k("up"), 80);
    Editor.key(ed, k("e", { ctrl: true }), 80);
    Editor.key(ed, k("b", { alt: true }), 80);
    Editor.key(ed, { $: "text", x: "big " }, 80);
    expect(ed.text).toBe("one big two\n");
    expect(Editor.key(ed, k("enter"), 80)).toBe("send");
    expect(Editor.take(ed)).toBe("one big two\n");
    Editor.key(ed, { $: "text", x: "draft" }, 80);
    Editor.key(ed, k("up"), 80);
    expect(ed.text).toBe("one big two\n");
    Editor.key(ed, k("down"), 80);
    Editor.key(ed, k("down"), 80);
    expect(ed.text).toBe("draft");
  });

  test("draws within the width, the cursor shown", () => {
    const ed = Editor.make();
    Editor.set(ed, "x".repeat(300) + "\n" + "日本語".repeat(40));
    const lines = Editor.draw(ed, 50);
    for (const line of lines) {
      expect(width(plain(line))).toBeLessThanOrEqual(50);
    }
    expect(lines.join("")).toContain("\x1b[7m");
  });
});

describe("draw", () => {
  test("a word stays whole across its styles, every line within the width", async () => {
    const { message } = await import("./Draw.ts");
    const text = "covering " + "word ".repeat(20) + "**1,090 memories**. Then `code`, and more.";
    for (const w of [30, 45, 60, 119]) {
      const lines = message("unii", text, w, false).map(plain);
      expect(lines.every((l) => width(l) <= w)).toBe(true);
      expect(lines.some((l) => l.trim() === ".")).toBe(false);
      expect(lines.join(" ")).toContain("memories.");
    }
  });
});

describe("render", () => {
  test("frames drawn by their changes match the screen and scrollback", () => {
    const term = term_make(40, 10);
    const r = Render.make((s) => term_write(term, s), 40, 10);
    let frame: string[] = [];
    let x = 5;
    for (let step = 0; step < 300; step++) {
      x = (x * 1103515245 + 12345) % 2147483648;
      const op = x % 5;
      if (op === 0 || frame.length < 3) {
        frame = [...frame, "line " + step];
      } else if (op === 1) {
        frame = [...frame.slice(0, -2), "edited " + step, ...frame.slice(-1)];
      } else if (op === 2) {
        frame = frame.slice(0, -1);
      } else if (op === 3) {
        frame = [...frame.slice(0, -3), "a" + step, "b" + step, "c" + step, "d" + step];
      } else {
        frame = [...frame];
      }
      Render.draw(r, frame);
      const want = frame.slice(Math.max(0, r.top), r.top + 10);
      expect(term_screen(term).slice(0, want.length)).toEqual(want);
      expect(term_screen(term).slice(want.length).every((row) => row === "")).toBe(true);
    }
  });

  test("a resize redraws all at the new width", () => {
    const term = term_make(80, 8);
    const r = Render.make((s) => term_write(term, s), 80, 8);
    const frame = Array.from({ length: 30 }, (_, k) => "row " + k);
    Render.draw(r, frame);
    Render.resize(r, 40, 8);
    term.w = 40;
    Render.draw(r, frame);
    expect(term_all(term)).toEqual(frame);
  });
});

describe("interactive mode", () => {
  function screen(w: number, h: number) {
    const term = term_make(w, h);
    return { term, out: (s: string) => term_write(term, s) };
  }

  test("a 200-line paste goes as one message", async () => {
    STUB.script = () => [{ t: "text", x: "got your paste" }];
    const { term, out } = screen(120, 40);
    const t = Tui.make(Store.make(CWD), out, 120, 40, () => {});
    const body = Array.from({ length: 200 }, (_, k) => "pasted line " + k).join("\r");
    for (const chunk of cuts("\x1b[200~" + body + "\x1b[201~", 3)) {
      Tui.input(t, chunk);
    }
    Tui.input(t, "\r");
    await until(() => !t.chat.busy && t.items.some((i) => i.kind === "unii"));
    const users = t.items.filter((i) => i.kind === "user");
    expect(users.length).toBe(1);
    expect(users[0].text.split("\n").length).toBe(200);
    expect(STUB.reqs.at(-1)!.last).toContain("pasted line 199");
    Tui.show(t);
    expect(term_screen(term).join("\n")).toContain("got your paste");
    await Tui.leave(t);
  });

  test("Esc stops a reply streaming within a second", async () => {
    STUB.script = () => [{ t: "text", x: "streaming" }, { t: "wait", ms: 30000 }];
    const { out } = screen(120, 40);
    const t = Tui.make(Store.make(CWD), out, 120, 40, () => {});
    Tui.input(t, "go\r");
    await until(() => t.live.length > 0);
    const t0 = performance.now();
    Tui.input(t, "\x1b");
    await Bun.sleep(40);
    await until(() => !t.chat.busy);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(t.items.at(-1)!.text).toBe("Stopped by the user.");
    await Tui.leave(t);
  });

  test("a resize mid-stream leaves every row whole", async () => {
    const words = Array.from({ length: 400 }, (_, k) => "word" + k).join(" ");
    STUB.script = () => [...cuts(words, 11).map((x) => ({ t: "text" as const, x })), { t: "wait", ms: 30000 }];
    const { term, out } = screen(120, 40);
    const t = Tui.make(Store.make(CWD), out, 120, 40, () => {});
    Tui.input(t, "long\r");
    await until(() => (t.live[0]?.text.length ?? 0) > 200);
    Tui.show(t);
    Render.resize(t.render, 60, 40);
    term.w = 60;
    Tui.show(t);
    await until(() => (t.live[0]?.text.length ?? 0) >= words.length);
    Tui.show(t);
    const frame = Tui.frame_lines(t).map(plain);
    const shown = term_screen(term);
    expect(shown).toEqual(frame.slice(-40).concat(Array(Math.max(0, 40 - frame.length)).fill("")).slice(0, 40));
    for (const row of term_all(term)) {
      expect(width(row)).toBeLessThan(60);
    }
    Local.interrupt(t.chat, "Stopped by the user.");
    await until(() => !t.chat.busy);
    await Tui.leave(t);
  });

  test("the model picker shows each model's price and context, and the one marked's facts", async () => {
    const { out } = screen(100, 40);
    const t = Tui.make(Store.make(CWD), out, 100, 40, () => {});
    Tui.send(t, "/model");
    Tui.show(t);
    const frame = Tui.frame_lines(t).map(plain);
    const text = frame.join("\n");
    // every vendor's model, the current one marked, its facts at the right
    expect(text).toContain("sonnet-5.5");
    expect(text).toContain("  claude-api");
    const marked = frame.find((l) => l.includes("sonnet-5.5 ✓"))!;
    expect(marked).toContain("1M");
    expect(marked.endsWith("$2·10")).toBe(true);
    expect(text).toContain("Ctx");
    expect(text).toContain("$/M");
    // the marked one's facts under the list
    expect(text).toContain("claude-sonnet-5-5 · 1M ctx · $2 in · $10 out · $0.1 cache per M tokens · speeds slow");
    for (const line of frame) {
      expect(width(line)).toBeLessThanOrEqual(99);
    }
    // typed letters filter; Enter picks the first hit
    Tui.input(t, "opus");
    Tui.input(t, "\r");
    expect(t.chat.pick.model).toBe("opus-5.5");
    expect(t.chat.pick.vendor).toBe("claude-api");
    await Tui.leave(t);
  });

  test("/login lists the providers; one chosen waits for its code, which signs it in", async () => {
    fs.rmSync(DIR + "/auth.json", { force: true });
    const { out } = screen(100, 40);
    const t = Tui.make(Store.make(CWD), out, 100, 40, () => {});
    Tui.send(t, "/login");
    Tui.show(t);
    const menu = Tui.frame_lines(t).map(plain).join("\n");
    expect(menu).toContain("openai-codex");
    expect(menu).toContain("opencode-go");
    expect(menu).toContain("signs codex in with your browser");

    // typing filters the providers; Enter signs in to the one marked
    Tui.input(t, "chatgpt");
    Tui.input(t, "\r");
    expect(t.login?.id).toBe("openai-codex");
    Tui.show(t);
    const waiting = Tui.frame_lines(t).map(plain).join("\n");
    expect(waiting).toContain("Sign in to ChatGPT (Plus/Pro)");
    expect(waiting).toContain("auth.openai.com/oauth/authorize");
    expect(waiting).toContain("paste the authorization code");

    const real = globalThis.fetch;
    const claims = { "https://api.openai.com/profile": { email: "someone@example.com" } };
    globalThis.fetch = (async () => new Response(JSON.stringify({
      access_token: "x." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".y", refresh_token: "r", expires_in: 3600,
    }), { status: 200 })) as typeof fetch;
    try {
      Tui.input(t, "the-code\r");
      await until(() => t.login === null);
    } finally {
      globalThis.fetch = real;
    }
    expect(t.notes.join(" ")).toContain("Signed in to ChatGPT (Plus/Pro) as someone@example.com");
    const config = await import("./Config.ts");
    expect(config.OFFER.vendors).toContain("codex");

    // and its models are offered now
    Tui.send(t, "/model");
    Tui.show(t);
    expect(Tui.frame_lines(t).map(plain).join("\n")).toContain("  codex");
    await Tui.leave(t);
  });

  test("Esc closes an open sign-in without sending anything", async () => {
    const { out } = screen(100, 40);
    const t = Tui.make(Store.make(CWD), out, 100, 40, () => {});
    Tui.send(t, "/login opencode-go");
    expect(t.login?.id).toBe("opencode-go");
    Tui.input(t, "\x1b");
    await Bun.sleep(WAIT + 20);
    expect(t.login).toBe(null);
    expect(t.notes.join(" ")).toContain("Sign-in cancelled");
    await Tui.leave(t);
  });

  test("a terminal reporting no size is drawn 80 by 24, not 0 wide", () => {
    const kept = ["columns", "rows"].map((k) => [k, Object.getOwnPropertyDescriptor(process.stdout, k)] as const);
    for (const k of ["columns", "rows"]) {
      Object.defineProperty(process.stdout, k, { value: 0, configurable: true });
    }
    try {
      expect(size()).toEqual({ w: 80, h: 24 });
    } finally {
      for (const [k, own] of kept) {
        if (own) {
          Object.defineProperty(process.stdout, k, own);
        } else {
          delete (process.stdout as any)[k];
        }
      }
    }
    expect(size().w).toBeGreaterThan(0);
  });
});

describe("input errors", () => {
  function fresh(): string {
    return fs.realpathSync(fs.mkdtempSync(os.tmpdir() + "/unii-tui-err-"));
  }

  function started(cwd: string) {
    const term = term_make(120, 40);
    const t = Tui.make(Store.make(cwd), (s) => term_write(term, s), 120, 40, () => {});
    return { t, shown: () => (Tui.show(t), term_all(term).join("\n")) };
  }

  async function answered({ t, shown }: ReturnType<typeof started>, text: string): Promise<void> {
    STUB.script = () => [{ t: "text", x: "reply to " + text }];
    Tui.input(t, text + "\r");
    await until(() => !t.chat.busy && shown().includes("reply to " + text));
    expect(shown()).toContain("reply to " + text);
  }

  // a chat with a message and its reply, closed; its session's dir
  async function older(cwd: string): Promise<string> {
    const chat = started(cwd);
    await answered(chat, "an older chat");
    await Tui.leave(chat.t);
    return chat.t.session.dir;
  }

  async function noted(t: ReturnType<typeof started>["t"]): Promise<string> {
    await until(() => t.notes.length > 0);
    return t.notes.join(" ");
  }

  // the user's messages in a session's log, as many times as logged
  function logged(dir: string): string[] {
    const lines = fs.readdirSync(dir + "/main").flatMap((f) => fs.readFileSync(dir + "/main/" + f, "utf8").split("\n").filter(Boolean));
    return lines.map((line) => JSON.parse(line)).filter((m) => m.kind === "user").map((m) => m.text);
  }

  function status({ t }: ReturnType<typeof started>): string {
    return plain(Tui.status(t, 1000));
  }

  // a message refused at `file` (0o555 a dir, 0o444 a file): noted, nothing
  // logged, back in the editor; Enter, once writable, sends it once
  async function refused(cwd: string, file: (dir: string) => string, mode: number, back: number): Promise<void> {
    const chat = started(cwd);
    const { dir } = chat.t.session;
    fs.chmodSync(file(dir), mode);
    Tui.input(chat.t, "hello\r");
    expect(await noted(chat.t)).toContain("EACCES");
    await until(() => !chat.t.chat.busy);
    expect(chat.t.chat.busy).toBe(false);
    expect(logged(dir)).toEqual([]);
    expect(chat.t.ed.text).toBe("hello");
    expect(chat.shown()).toContain("› hello");
    fs.chmodSync(file(dir), back);
    STUB.script = () => [{ t: "text", x: "reply to the one sent" }];
    Tui.input(chat.t, "\r");
    await until(() => !chat.t.chat.busy && chat.shown().includes("reply to the one sent"));
    expect(chat.shown()).toContain("reply to the one sent");
    expect(logged(dir)).toEqual(["hello"]);
    expect(chat.t.ed.text).toBe("");
    expect(chat.t.ed.history).toEqual(["hello"]);
    expect(STUB.reqs.at(-1)!.last).toContain("hello");
    await Tui.leave(chat.t);
  }

  test("/import of a missing dir leaves the session running with a note on screen", async () => {
    const chat = started(fresh());
    const { id } = chat.t.session;
    Tui.input(chat.t, "/import /nothing/here\r");
    await noted(chat.t);
    expect(chat.shown()).toContain("no chat to import at /nothing/here");
    expect(chat.shown()).not.toContain("Imported");
    expect(chat.t.session.id).toBe(id);
    await answered(chat, "still here");
    await Tui.leave(chat.t);
  });

  const BAD: Array<[string, (src: string) => void]> = [
    ["a main.index that is a directory", (src) => fs.mkdirSync(src + "/main.index")],
    ["a main that is a file", (src) => {
      fs.writeFileSync(src + "/main.index", "");
      fs.writeFileSync(src + "/main", "x");
    }],
    ["a main that can't be read", (src) => {
      fs.writeFileSync(src + "/main.index", "");
      fs.mkdirSync(src + "/main", { mode: 0o000 });
    }],
  ];

  for (const [name, spoil] of BAD) {
    test("a failed import of " + name + " leaves no new session and the latest as it was", async () => {
      const cwd = fresh();
      const chat = started(cwd);
      const src = fresh();
      spoil(src);
      const before = fs.readdirSync(Store.home(cwd));
      const latest = Store.latest(cwd)!.id;
      Tui.input(chat.t, "/import " + src + "\r");
      const note = await noted(chat.t);
      expect(note).not.toContain("Imported");
      expect(note).not.toContain("null is not");
      expect(note).not.toContain("Invalid Date");
      expect(fs.readdirSync(Store.home(cwd))).toEqual(before);
      expect(Store.latest(cwd)!.id).toBe(latest);
      await answered(chat, "still here");
      await Tui.leave(chat.t);
      fs.chmodSync(src, 0o755);
      if (fs.existsSync(src + "/main")) {
        fs.chmodSync(src + "/main", 0o755);
      }
    });
  }

  function garble(dir: string): void {
    const day = dir + "/main/" + fs.readdirSync(dir + "/main")[0];
    const lines = fs.readFileSync(day, "utf8").split("\n");
    lines[0] = "x".repeat(lines[0].length);
    fs.writeFileSync(day, lines.join("\n"));
  }

  test("an import that passes its checks and won't open leaves no new session", async () => {
    const cwd = fresh();
    const src = await older(fresh());
    garble(src);
    const chat = started(cwd);
    const before = fs.readdirSync(Store.home(cwd));
    const latest = Store.latest(cwd)!.id;
    Tui.input(chat.t, "/import " + src + "\r");
    expect(await noted(chat.t)).toContain("can't be opened: its files are damaged: ");
    expect(chat.t.notes.join(" ")).not.toContain("Imported");
    expect(fs.readdirSync(Store.home(cwd))).toEqual(before);
    expect(Store.latest(cwd)!.id).toBe(latest);
    await answered(chat, "still here");
    await Tui.leave(chat.t);
  });

  function saved_end(dir: string, log: string, end: [number, number]): void {
    const view = JSON.parse(fs.readFileSync(dir + "/view.json", "utf8"));
    fs.writeFileSync(dir + "/view.json", JSON.stringify({ ...view, [log]: end }));
  }

  function first_line_only(dir: string): void {
    const day = dir + "/main/" + fs.readdirSync(dir + "/main")[0];
    fs.writeFileSync(day, fs.readFileSync(day, "utf8").split("\n")[0] + "\n");
  }

  function slot_past_its_file(dir: string): void {
    const index = fs.readFileSync(dir + "/main.index");
    index.writeDoubleLE(1e9, 16);
    fs.writeFileSync(dir + "/main.index", index);
  }

  const IS_DAMAGED = "its files are damaged: ";

  const DAMAGED: Array<[string, (dir: string) => void, string, (dir: string) => void]> = [
    ["a corrupt main.index", (dir) => fs.writeFileSync(dir + "/main.index", Buffer.alloc(16, 0xff)), IS_DAMAGED, () => {}],
    ["a main.index of zeros", (dir) => fs.writeFileSync(dir + "/main.index", Buffer.alloc(32)), IS_DAMAGED, () => {}],
    ["a main.index cut short", (dir) => fs.appendFileSync(dir + "/main.index", Buffer.alloc(5)), IS_DAMAGED, () => {}],
    ["a slot past its file", slot_past_its_file, IS_DAMAGED, () => {}],
    ["a slot of an impossible day", (dir) => {
      const index = fs.readFileSync(dir + "/main.index");
      index.writeUInt32LE(0xffffffff, 8);
      fs.writeFileSync(dir + "/main.index", index);
    }, IS_DAMAGED, () => {}],
    ["a log line of garbage", garble, IS_DAMAGED, () => {}],
    ["a log shorter than its saved end", first_line_only, IS_DAMAGED, () => {}],
    ["a saved end that is no number", (dir) => saved_end(dir, "main", [JSON.parse(fs.readFileSync(dir + "/view.json", "utf8")).main[0], "x" as any]), IS_DAMAGED, () => {}],
    ["a dir it can't write", (dir) => fs.chmodSync(dir, 0o555), "EACCES", (dir) => fs.chmodSync(dir, 0o755)],
  ];

  for (const [name, spoil, says, mend] of DAMAGED) {
    test("a failed /resume pick of " + name + " leaves the old chat answering", async () => {
      const cwd = fresh();
      const dir = await older(cwd);
      const chat = started(cwd);
      await answered(chat, "this chat");
      const { id } = chat.t.session;
      spoil(dir);
      Tui.input(chat.t, "/resume\r");
      Tui.input(chat.t, "older");
      Tui.input(chat.t, "\r");
      const note = await noted(chat.t);
      expect(note).toContain("can't be opened: " + says);
      expect(note).not.toContain("Invalid Date");
      expect(note).not.toContain("JSON Parse");
      expect(note).not.toContain("out of range");
      expect(note).not.toContain("a bug in unii");
      expect(chat.t.session.id).toBe(id);
      expect(chat.shown()).toContain("reply to this chat");
      expect(fs.readFileSync(chat.t.session.dir + "/lock", "utf8")).toBe(String(process.pid));
      expect(fs.existsSync(dir + "/lock")).toBe(false);
      await answered(chat, "still here");
      expect(Store.last(chat.t.session.dir)!.text).toBe("reply to still here");
      await Tui.leave(chat.t);
      mend(dir);
    });
  }

  test("a failed /resume pick leaves a turn that runs running", async () => {
    const cwd = fresh();
    const dir = await older(cwd);
    fs.writeFileSync(dir + "/main.index", Buffer.alloc(16, 0xff));
    const chat = started(cwd);
    STUB.script = () => [{ t: "wait", ms: 200 }, { t: "text", x: "the turn went on" }];
    Tui.input(chat.t, "go\r");
    await until(() => chat.t.chat.call !== null);
    Tui.input(chat.t, "/resume\r");
    Tui.input(chat.t, "older");
    Tui.input(chat.t, "\r");
    await noted(chat.t);
    await until(() => chat.shown().includes("the turn went on"));
    expect(chat.shown()).toContain("the turn went on");
    await Tui.leave(chat.t);
  });

  async function planted(chat: ReturnType<typeof started>, err: () => unknown): Promise<string> {
    const key = Tui.key;
    (Tui as any).key = () => {
      throw err();
    };
    chat.t.notes = [];
    Tui.input(chat.t, "x");
    const note = await noted(chat.t);
    (Tui as any).key = key;
    return note;
  }

  test("a code bug a key runs says so in its note, and errors.log holds its time and stack, for the owner alone", async () => {
    const chat = started(fresh());
    const note = await planted(chat, () => new TypeError("planted in a key"));
    expect(note).toContain("planted in a key");
    expect(note).toContain("a bug in unii");
    expect(note).toContain(LOG);
    const log = fs.readFileSync(LOG, "utf8");
    expect(log).toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z\nTypeError: planted in a key\n/);
    expect(log).toContain("Tui.test.ts");
    expect(fs.statSync(LOG).mode & 0o777).toBe(0o600);
    await answered(chat, "still here");
    await Tui.leave(chat.t);
  });

  test("a code error carrying an ERR_ code is a bug, not a system error", async () => {
    const chat = started(fresh());
    expect(await planted(chat, () => {
      try {
        Buffer.alloc(-1);
      } catch (err) {
        return err;
      }
    })).toContain("a bug in unii");
    await Tui.leave(chat.t);
  });

  test("an error the user can act on keeps its note as it was, and is logged too", async () => {
    const chat = started(fresh());
    expect(await planted(chat, () => new Error("planted for the user"))).toBe("planted for the user");
    expect(fs.readFileSync(LOG, "utf8")).toContain("Error: planted for the user\n");
    chat.t.notes = [];
    const { dir } = chat.t.session;
    fs.chmodSync(dir, 0o555);
    Tui.input(chat.t, "/model haiku\r");
    const denied = await noted(chat.t);
    fs.chmodSync(dir, 0o755);
    expect(denied).toContain("EACCES");
    expect(denied).not.toContain("a bug in unii");
    expect(fs.readFileSync(LOG, "utf8")).toContain("EACCES");
    await Tui.leave(chat.t);
  });

  test("an errors.log that can't be written never masks the note, and no note points at it", async () => {
    const chat = started(fresh());
    const kept = fs.existsSync(LOG) ? fs.readFileSync(LOG) : Buffer.alloc(0);
    fs.rmSync(LOG, { force: true });
    fs.mkdirSync(LOG);
    const note = await planted(chat, () => new TypeError("planted, no log"));
    fs.rmdirSync(LOG);
    fs.writeFileSync(LOG, kept, { mode: 0o600 });
    expect(note).toContain("planted, no log");
    expect(note).toContain("a bug in unii");
    expect(note).not.toContain(LOG);
    await answered(chat, "still here");
    await Tui.leave(chat.t);
  });

  for (const w of [80, 30]) {
    test("a turn waiting on a failing summary shows why on its own row at width " + w + ", whatever its reason holds", async () => {
      const term = term_make(w, 40);
      const t = Tui.make(Store.make(fresh()), (s) => term_write(term, s), w, 40, () => {});
      const ask = Memory.ask;
      (Memory as any).ask = () => {
        throw new Error("\n\x1b[31mplanted " + "long ".repeat(100) + "\nsecond line");
      };
      const wide = "word ".repeat(2000);
      let shown: string[] = [];
      try {
        Tui.input(t, "first " + wide + "\r");
        await until(() => !t.chat.busy, 10000);
        Tui.input(t, "second " + wide + "\r");
        await until(() => Local.stuck(t.chat) !== "", 10000);
        Tui.show(t);
        shown = term_screen(term);
      } finally {
        (Memory as any).ask = ask;
      }
      const status = shown.findIndex((l) => l.includes("summarizing"));
      expect(width(plain(shown[status]))).toBeLessThan(w);
      expect(shown[status + 1]).toContain("  failed, trying again:");
      expect(width(plain(shown[status + 1]))).toBeLessThan(w);
      expect(shown[status + 2], "the next row is the rule").toContain("──");
      if (w === 80) {
        expect(shown[status]).toContain("(esc to stop)");
        expect(shown[status + 1]).toContain("planted long long");
      }
      expect(shown.join("\n")).not.toContain("second line");
      expect(t.notes).toEqual([]);
      await until(() => !t.chat.busy, 10000);
      await Tui.leave(t);
    }, 30000);
  }

  test("a code bug opening a session is a bug's note, never damage, and that chat stays unheld", async () => {
    const cwd = fresh();
    const dir = await older(cwd);
    const chat = started(cwd);
    const { id } = chat.t.session;
    const open = Local.open;
    (Local as any).open = () => {
      throw new TypeError("planted in an open");
    };
    Tui.input(chat.t, "/resume\r");
    Tui.input(chat.t, "older");
    Tui.input(chat.t, "\r");
    const note = await noted(chat.t);
    (Local as any).open = open;
    expect(note).not.toContain("damaged");
    expect(note).toContain("planted in an open");
    expect(note).toContain("a bug in unii");
    expect(fs.readFileSync(LOG, "utf8")).toContain("TypeError: planted in an open\n");
    expect(chat.t.session.id).toBe(id);
    expect(fs.existsSync(dir + "/lock")).toBe(false);
    await answered(chat, "still here");
    await Tui.leave(chat.t);
  });

  test("a command that throws is a note, the chat goes on", async () => {
    const chat = started(fresh());
    const { dir } = chat.t.session;
    fs.chmodSync(dir, 0o555);
    Tui.input(chat.t, "/model haiku\r");
    expect(await noted(chat.t)).toContain("EACCES");
    fs.chmodSync(dir, 0o755);
    await answered(chat, "still here");
    await Tui.leave(chat.t);
  });

  test("/new where no session can be made is a note", async () => {
    const cwd = fresh();
    const chat = started(cwd);
    const { id } = chat.t.session;
    fs.chmodSync(Store.home(cwd), 0o555);
    Tui.input(chat.t, "/new\r");
    expect(await noted(chat.t)).toContain("EACCES");
    fs.chmodSync(Store.home(cwd), 0o755);
    expect(chat.t.session.id).toBe(id);
    await answered(chat, "still here");
    await Tui.leave(chat.t);
  });

  test("a picker's Enter that throws is a note, the chat goes on", async () => {
    const chat = started(fresh());
    const { dir } = chat.t.session;
    Tui.input(chat.t, "/model\r");
    Tui.input(chat.t, "haiku");
    fs.chmodSync(dir, 0o555);
    Tui.input(chat.t, "\r");
    expect(await noted(chat.t)).toContain("EACCES");
    expect(chat.t.menu).toBe(null);
    fs.chmodSync(dir, 0o755);
    await answered(chat, "still here");
    await Tui.leave(chat.t);
  });

  test("a message with its session's dir gone is a note", async () => {
    const chat = started(fresh());
    fs.rmSync(chat.t.session.dir, { recursive: true });
    Tui.input(chat.t, "hello\r");
    expect(await noted(chat.t)).toContain("ENOENT");
    expect(chat.t.chat.busy).toBe(false);
    expect(chat.t.ed.text).toBe("hello");
    await Tui.leave(chat.t);
  });

  test("a message with its session's dir unwritable is a note, back in the editor, sent once by Enter", async () => {
    await refused(fresh(), (dir) => dir, 0o555, 0o755);
  });

  test("a message its log's dir refuses is a note, back in the editor, sent once by Enter", async () => {
    await refused(fresh(), (dir) => dir + "/main", 0o555, 0o755);
  });

  test("a message its log's index refuses is a note, back in the editor, sent once by Enter", async () => {
    await refused(fresh(), (dir) => dir + "/main.index", 0o444, 0o644);
  });

  test("a message logged before a later write fails stays out of the editor, so it isn't sent twice", async () => {
    const chat = started(fresh());
    const { dir } = chat.t.session;
    fs.chmodSync(dir + "/tree", 0o555);
    Tui.input(chat.t, "hello\r");
    expect(await noted(chat.t)).toContain("EACCES");
    expect(logged(dir)).toEqual(["hello"]);
    expect(chat.t.ed.text).toBe("");
    fs.chmodSync(dir + "/tree", 0o755);
    await answered(chat, "still here");
    expect(logged(dir)).toEqual(["hello", "still here"]);
    await Tui.leave(chat.t);
  });

  test("a /model or /effort that can't be saved keeps the old values on the status line", async () => {
    const chat = started(fresh());
    const { dir } = chat.t.session;
    const was = status(chat);
    fs.chmodSync(dir, 0o555);
    for (const cmd of ["/model haiku", "/effort high"]) {
      chat.t.notes = [];
      Tui.input(chat.t, cmd + "\r");
      expect(await noted(chat.t)).toContain("EACCES");
      expect(status(chat)).toBe(was);
    }
    fs.chmodSync(dir, 0o755);
    await answered(chat, "still here");
    expect(status(chat)).toStartWith(was.split(" ").slice(0, 2).join(" "));
    await Tui.leave(chat.t);
  });

  test("a /goal that can't be saved sets no goal: nothing logged, the next message unchecked", async () => {
    const chat = started(fresh());
    const { dir } = chat.t.session;
    fs.chmodSync(dir, 0o555);
    Tui.input(chat.t, "/goal ship it\r");
    expect(await noted(chat.t)).toContain("EACCES");
    expect(status(chat)).not.toContain("goal:");
    expect(logged(dir)).toEqual([]);
    fs.chmodSync(dir, 0o755);
    await answered(chat, "still here");
    expect(logged(dir)).toEqual(["still here"]);
    expect(Memory.saved(dir)!.goal).toBe(null);
    await Tui.leave(chat.t);
  });

  test("a /goal whose message can't be logged sets no goal", async () => {
    const chat = started(fresh());
    const { dir } = chat.t.session;
    fs.chmodSync(dir + "/main", 0o555);
    Tui.input(chat.t, "/goal ship it\r");
    expect(await noted(chat.t)).toContain("EACCES");
    fs.chmodSync(dir + "/main", 0o755);
    expect(status(chat)).not.toContain("goal:");
    expect(Memory.saved(dir)!.goal).toBe(null);
    await answered(chat, "still here");
    expect(logged(dir)).toEqual(["still here"]);
    await Tui.leave(chat.t);
  });

  test("a /goal on a healthy disk is saved, logged once, and checked", async () => {
    const chat = started(fresh());
    const { dir } = chat.t.session;
    STUB.script = (req) => [{ t: "text", x: req.last.includes("The goal:") ? "yes" : "working on it" }];
    Tui.input(chat.t, "/goal ship it\r");
    expect(status(chat)).toContain("goal: ship it");
    expect(Memory.saved(dir)!.goal).toBe("ship it");
    await until(() => !chat.t.chat.busy && chat.shown().includes("Goal met."));
    expect(chat.shown()).toContain("Goal met.");
    expect(logged(dir)).toEqual(["/goal ship it"]);
    expect(chat.t.chat.mem.goal).toBe(null);
    await Tui.leave(chat.t);
  });

  for (const [name, text] of [["an object with no parts", "{}"], ["a number", "5"], ["parts of no pairs", '{"parts":[null]}'], ["a seen with no parts", '{"parts":[],"seen":{}}']]) {
    test("a /resume pick whose view.json is " + name + " rebuilds from the logs, as an unreadable one does", async () => {
      const cwd = fresh();
      const dir = await older(cwd);
      fs.writeFileSync(dir + "/view.json", text);
      const chat = started(cwd);
      const { id } = chat.t.session;
      Tui.input(chat.t, "/resume\r");
      Tui.input(chat.t, "older");
      Tui.input(chat.t, "\r");
      await until(() => chat.t.session.id !== id || chat.t.notes.length > 0);
      expect(chat.t.notes.join(" ")).toBe("");
      expect(chat.shown()).toContain("reply to an older chat");
      await answered(chat, "goes on");
      await Tui.leave(chat.t);
    });
  }

  const REBUILT: Array<[string, (src: string) => void]> = [
    ["a main.index cut short and no view.json", (src) => {
      fs.rmSync(src + "/view.json");
      fs.writeFileSync(src + "/main.index", Buffer.alloc(37, 1));
    }],
    ["a main.index of whole entries of garbage and no view.json", (src) => {
      fs.rmSync(src + "/view.json");
      fs.writeFileSync(src + "/main.index", Buffer.alloc(16, 0xff));
    }],
    ["a garbage main.index and a view.json that can't be parsed", (src) => {
      fs.writeFileSync(src + "/view.json", "{ not json");
      fs.writeFileSync(src + "/main.index", Buffer.alloc(37, 1));
    }],
    ["a garbage main.index and a saved end of zero", (src) => {
      saved_end(src, "main", [0, 0]);
      fs.writeFileSync(src + "/main.index", Buffer.alloc(37, 1));
    }],
    ["a garbage tree.index and a saved end of zero", (src) => {
      saved_end(src, "tree", [0, 0]);
      fs.writeFileSync(src + "/tree.index", Buffer.alloc(37, 1));
    }],
  ];

  for (const [name, spoil] of REBUILT) {
    test("an import of " + name + " rebuilds from the logs, says the lines it has, and answers", async () => {
      const src = await older(fresh());
      spoil(src);
      const chat = started(fresh());
      const first = chat.t.session;
      Tui.input(chat.t, "/import " + src + "\r");
      await until(() => chat.t.session.id !== first.id && chat.t.notes.length > 0);
      expect(chat.t.notes.join(" ")).toContain("Imported " + src + " as a new session: 2 lines.");
      expect(chat.shown()).toContain("reply to an older chat");
      await answered(chat, "goes on");
      await Tui.leave(chat.t);
    });
  }

  test("an import of a garbage main.index with no logs and no view.json is an empty chat that answers", async () => {
    const src = fresh();
    fs.writeFileSync(src + "/main.index", Buffer.alloc(16, 0xff));
    const chat = started(fresh());
    const first = chat.t.session;
    Tui.input(chat.t, "/import " + src + "\r");
    await until(() => chat.t.session.id !== first.id && chat.t.notes.length > 0);
    expect(chat.t.notes.join(" ")).toContain("Imported " + src + " as a new session: 0 lines.");
    await answered(chat, "goes on");
    await Tui.leave(chat.t);
  });

  const REFUSED: Array<[string, (src: string) => void]> = [
    ["a view.json that is a directory", (src) => {
      fs.rmSync(src + "/view.json");
      fs.mkdirSync(src + "/view.json");
    }],
    ["a log shorter than its saved end", first_line_only],
    ["a garbage main.index with a saved end", (src) => fs.writeFileSync(src + "/main.index", Buffer.alloc(37, 1))],
  ];

  for (const [name, spoil] of REFUSED) {
    test("an import of " + name + " is refused before any copy", async () => {
      const cwd = fresh();
      const src = await older(fresh());
      spoil(src);
      const chat = started(cwd);
      const before = fs.readdirSync(Store.home(cwd));
      Tui.input(chat.t, "/import " + src + "\r");
      expect(await noted(chat.t)).toContain("no chat to import at " + src + ": ");
      expect(fs.readdirSync(Store.home(cwd))).toEqual(before);
      await answered(chat, "still here");
      await Tui.leave(chat.t);
    });
  }

  test("a good /import shows its history, says so, and answers", async () => {
    const cwd = fresh();
    const src = await older(fresh());
    const chat = started(cwd);
    const first = chat.t.session;
    Tui.input(chat.t, "/import " + src + "\r");
    await until(() => chat.t.session.id !== first.id && chat.t.notes.length > 0);
    expect(chat.t.notes.join(" ")).toContain("Imported " + src + " as a new session: 2 lines.");
    expect(chat.shown()).toContain("reply to an older chat");
    expect(fs.existsSync(first.dir + "/lock")).toBe(false);
    await answered(chat, "goes on");
    await Tui.leave(chat.t);
  });

  describe("switching sessions", () => {
    const STOPPED = "Stopped: another session opened.";

    // Local.close as it is, its first call answered only once `open` runs
    function held() {
      const real = Local.close;
      let calls = 0;
      let open = () => {};
      const gate = new Promise<void>((ok) => (open = ok));
      (Local as any).close = async (chat: unknown) => {
        await real(chat as any);
        if (calls++ === 0) {
          await gate;
        }
      };
      return { open, restore: () => ((Local as any).close = real) };
    }

    function locked(cwd: string): string[] {
      return fs.readdirSync(Store.home(cwd)).filter((id) => fs.existsSync(Store.home(cwd) + "/" + id + "/lock"));
    }

    test("/new during a reply says so on the new screen, and the old log keeps it", async () => {
      STUB.script = () => [{ t: "wait", ms: 30000 }];
      const chat = started(fresh());
      const first = chat.t.session;
      Tui.input(chat.t, "go\r");
      await until(() => chat.t.chat.call !== null);
      Tui.input(chat.t, "/new\r");
      await until(() => chat.t.session.id !== first.id);
      expect(chat.t.items).toEqual([]);
      expect(chat.shown()).toContain(STOPPED);
      await until(() => Store.last(first.dir)?.text === STOPPED);
      expect(Store.last(first.dir)?.text).toBe(STOPPED);
      await Tui.leave(chat.t);
    });

    test("/new with no reply running says nothing was stopped", async () => {
      const chat = started(fresh());
      const first = chat.t.session;
      Tui.input(chat.t, "/new\r");
      await until(() => chat.t.session.id !== first.id);
      expect(chat.shown()).not.toContain(STOPPED);
      await Tui.leave(chat.t);
    });

    test("a message typed while the old chat closes goes to the new chat", async () => {
      const slow = held();
      try {
        const chat = started(fresh());
        const first = chat.t.session;
        STUB.script = () => [{ t: "text", x: "reply to typed" }];
        Tui.input(chat.t, "/new\r");
        Tui.input(chat.t, "typed");
        Tui.input(chat.t, "\r");
        await Bun.sleep(20);
        expect(Store.last(first.dir)).toBe(null);
        slow.open();
        await until(() => chat.shown().includes("reply to typed"));
        expect(chat.t.session.id).not.toBe(first.id);
        expect(Store.last(chat.t.session.dir)?.text).toBe("reply to typed");
        expect(Store.last(first.dir)).toBe(null);
        await Tui.leave(chat.t);
      } finally {
        slow.restore();
      }
    });

    test("two quick /new end on the last one made, a message after them in it, only it locked", async () => {
      const slow = held();
      try {
        const cwd = fresh();
        const chat = started(cwd);
        const first = chat.t.session;
        STUB.script = () => [{ t: "text", x: "reply to typed" }];
        Tui.input(chat.t, "/new\r/new\rtyped\r");
        await Bun.sleep(20);
        slow.open();
        await until(() => chat.shown().includes("reply to typed"), 1000);
        const ids = fs.readdirSync(Store.home(cwd)).sort();
        expect(ids.length).toBe(3);
        expect(ids[0]).toBe(first.id);
        expect(chat.t.session.id).toBe(ids[2]);
        expect(Store.last(Store.home(cwd) + "/" + ids[2])?.text).toBe("reply to typed");
        expect(Store.last(Store.home(cwd) + "/" + ids[1])).toBe(null);
        expect(Store.last(first.dir)).toBe(null);
        expect(locked(cwd)).toEqual([ids[2]]);
        await Tui.leave(chat.t);
      } finally {
        slow.restore();
      }
    });

    test("a resumed chat left at once stops, its turn not on the next screen", async () => {
      const cwd = fresh();
      STUB.script = () => [{ t: "wait", ms: 30000 }];
      const cut = started(cwd);
      Tui.input(cut.t, "the cut turn\r");
      await until(() => cut.t.chat.call !== null);
      await Tui.leave(cut.t);
      await until(() => !cut.t.chat.busy);
      const chat = started(cwd);
      const first = chat.t.session;
      STUB.script = () => [{ t: "wait", ms: 50 }, { t: "text", x: "reply of the resumed turn" }];
      const slow = held();
      try {
        Tui.input(chat.t, "/resume\rNo reply\r/new\r");
        await Bun.sleep(20);
        slow.open();
        await until(() => chat.t.session.id !== first.id && chat.t.session.id !== cut.t.session.id, 500);
        await Bun.sleep(150);
        expect(chat.t.session.id).not.toBe(cut.t.session.id);
        expect(chat.shown()).not.toContain("reply of the resumed turn");
        expect(Store.last(cut.t.session.dir)?.text).toBe(STOPPED);
        expect(locked(cwd)).toEqual([chat.t.session.id]);
        await Tui.leave(chat.t);
      } finally {
        slow.restore();
      }
    });

    test("what a closed chat writes late stays in its log, off the new screen", async () => {
      const chat = started(fresh());
      const first = chat.t.session;
      const old = chat.t.chat;
      Tui.input(chat.t, "/new\r");
      await until(() => chat.t.session.id !== first.id);
      Local.push(old, "note", "late from the old chat");
      expect(chat.t.items).toEqual([]);
      expect(chat.shown()).not.toContain("late from the old chat");
      expect(Store.last(first.dir)?.text).toBe("late from the old chat");
      await Tui.leave(chat.t);
    });

    test("a close that fails lands on the new chat, the failure a note there", async () => {
      const real = Local.close;
      let fail = true;
      (Local as any).close = async (chat: unknown) => {
        await real(chat as any);
        if (fail) {
          fail = false;
          throw new Error("the close failed");
        }
      };
      try {
        const cwd = fresh();
        const chat = started(cwd);
        const first = chat.t.session;
        Tui.input(chat.t, "/new\r");
        expect(await noted(chat.t)).toContain("the close failed");
        expect(chat.t.session.id).not.toBe(first.id);
        expect(chat.shown()).toContain("the close failed");
        expect(locked(cwd)).toEqual([chat.t.session.id]);
        await answered(chat, "goes on");
        expect(Store.last(chat.t.session.dir)?.text).toBe("reply to goes on");
        await Tui.leave(chat.t);
      } finally {
        (Local as any).close = real;
      }
    });

    test("a quit during a switch enters nothing and leaves no session locked", async () => {
      const slow = held();
      try {
        const cwd = fresh();
        const chat = started(cwd);
        const first = chat.t.session;
        Tui.input(chat.t, "/new\r");
        const left = Tui.leave(chat.t);
        await Bun.sleep(20);
        slow.open();
        await left;
        await Bun.sleep(20);
        expect(fs.readdirSync(Store.home(cwd)).length).toBe(2);
        expect(locked(cwd)).toEqual([]);
        expect(chat.t.session.id).toBe(first.id);
      } finally {
        slow.restore();
      }
    });
  });
});

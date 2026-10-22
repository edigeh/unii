// Tui test
// ========
// `bun test Tui.test.ts`. The terminal side of the harness, on a stubbed
// wire (wire.stub.ts) and a stubbed terminal (term.stub.ts): keys read
// from chunks cut anywhere, a paste whole; the editor's keys; the
// renderer's frames, drawn by their changes only, match the frame on the
// screen and in the scrollback, a resize too; the whole interactive mode:
// a 200-line paste goes as one message, Esc stops a reply, a resize mid
// stream leaves every row whole.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

const DIR = fs.mkdtempSync(os.tmpdir() + "/unii-tui-");
process.env.UNII_DIR = DIR;

const { Keys } = await import("./Keys.ts");
const { Editor } = await import("./Editor.ts");
const { Render } = await import("./Render.ts");
const { Tui } = await import("./Tui.ts");
const { Store } = await import("./Store.ts");
const { Local } = await import("./Local.ts");
const { STUB, stub_install, stub_remove } = await import("./wire.stub.ts");
const { term_make, term_write, term_screen, term_all, plain } = await import("./term.stub.ts");
const { width } = await import("./Draw.ts");

type Key = import("./Keys.ts").Key;

const CWD = fs.realpathSync(fs.mkdtempSync(os.tmpdir() + "/unii-tui-cwd-"));

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
});

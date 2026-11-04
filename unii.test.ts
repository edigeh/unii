// unii test
// =========
// `bun test unii.test.ts`. How unii starts: a session the user didn't name
// that won't open gives way to a new one, the damaged one kept and no
// empty ones piling up; an import that won't open from the shell leaves
// nothing; the --resume picker holds a turn a crash cut till it closes on
// that session; a last error at startup leaves its stack.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DIR } from "./scratch.stub.ts";

const { Tui } = await import("./Tui.ts");
const { Store } = await import("./Store.ts");
const { Local, TURN } = await import("./Local.ts");
const { Memory } = await import("./Memory.ts");
const { main } = await import("./unii.ts");
const { STUB, stub_install, stub_remove } = await import("./wire.stub.ts");
const { term_make, term_write, term_all } = await import("./term.stub.ts");

type Session = import("./Store.ts").Session;

const LOG = DIR + "/errors.log";
const hooks = { entry: () => {}, live: () => {}, mind: () => {}, state: () => {}, ended: () => {}, fault: () => {} };

beforeAll(stub_install);
afterAll(stub_remove);

function fresh(): string {
  return fs.realpathSync(fs.mkdtempSync(os.tmpdir() + "/unii-start-cwd-"));
}

async function until(ok: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) {
    await Bun.sleep(10);
  }
}

function started(session: Session, opts: { chosen?: boolean; resume?: boolean } = {}) {
  const term = term_make(120, 40);
  const t = Tui.make(session, (s) => term_write(term, s), 120, 40, () => {}, opts);
  if (opts.resume) {
    Tui.sessions(t, true);
  }
  return { t, shown: () => (Tui.show(t), term_all(term).join("\n")) };
}

// a chat with a message and its reply, closed
async function older(cwd: string, text = "an older chat"): Promise<Session> {
  STUB.script = () => [{ t: "text", x: "the reply" }];
  const chat = started(Store.make(cwd));
  Tui.input(chat.t, text + "\r");
  await until(() => !chat.t.chat.busy && chat.shown().includes("the reply"));
  await Tui.leave(chat.t);
  return Store.read(chat.t.session.dir)!;
}

// the last line of the log garbled, its length kept: Store.flaw passes it, a load doesn't
function garble(dir: string): void {
  const day = dir + "/main/" + fs.readdirSync(dir + "/main").sort().at(-1);
  const lines = fs.readFileSync(day, "utf8").split("\n");
  lines[lines.length - 2] = "x".repeat(lines[lines.length - 2].length);
  fs.writeFileSync(day, lines.join("\n"));
}

function damaged_copy_of(dir: string): string {
  const src = fs.mkdtempSync(os.tmpdir() + "/unii-start-src-");
  fs.cpSync(dir, src, { recursive: true });
  garble(src);
  return src;
}

function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir, { recursive: true }) as string[]) {
    if (fs.statSync(dir + "/" + name).isFile()) {
      out[name] = fs.readFileSync(dir + "/" + name, "latin1");
    }
  }
  return out;
}

// a session whose turn a crash cut: its message logged, the turn saved as running
function cut_turn(cwd: string): Session {
  const session = Store.make(cwd);
  const chat = Local.open(session.dir, cwd, hooks);
  Memory.push(chat.mem, [{ kind: "user", text: "a cut turn" }]);
  chat.mem.work = [TURN];
  Memory.save(chat.mem);
  Memory.stop(chat.mem);
  Bun.sleepSync(5);
  return Store.read(session.dir)!;
}

function logged(dir: string): string {
  return Object.entries(files(dir)).filter(([name]) => name.startsWith("main/")).map(([, text]) => text).join("");
}

function saved_work(dir: string): string[] {
  return JSON.parse(fs.readFileSync(dir + "/view.json", "utf8")).work;
}

async function terminal<A>(on: boolean, cwd: string, run: () => Promise<A>): Promise<A> {
  const was = [process.stdin.isTTY, process.stdout.isTTY, process.cwd()] as const;
  process.stdin.isTTY = on;
  process.stdout.isTTY = on;
  process.chdir(cwd);
  try {
    return await run();
  } finally {
    process.stdin.isTTY = was[0];
    process.stdout.isTTY = was[1];
    process.chdir(was[2]);
  }
}

describe("a session chosen for the user", () => {
  test("one that won't open gives way to a new session that says why, and it stays untouched", async () => {
    const cwd = fresh();
    const bad = await older(cwd);
    garble(bad.dir);
    const before = files(bad.dir);
    const chat = started(Store.latest(cwd)!, { chosen: true });
    expect(chat.t.session.id).not.toBe(bad.id);
    expect(chat.shown()).toContain("Session " + bad.id + " can't be opened: its files are damaged: ");
    expect(chat.shown()).toContain("/resume");
    expect(chat.t.chat.mem.count).toBe(0);
    expect(fs.readFileSync(LOG, "utf8")).toContain("is not JSON");
    STUB.script = () => [{ t: "text", x: "fresh reply" }];
    Tui.input(chat.t, "hello\r");
    await until(() => !chat.t.chat.busy && chat.shown().includes("fresh reply"));
    expect(chat.shown()).toContain("fresh reply");
    await Tui.leave(chat.t);
    expect(files(bad.dir)).toEqual(before);
  });

  test("three starts on one that won't open make one new session, chosen after", async () => {
    const cwd = fresh();
    const bad = await older(cwd);
    garble(bad.dir);
    const opened: string[] = [];
    const said: boolean[] = [];
    for (let k = 0; k < 3; k++) {
      const chat = started(Store.latest(cwd)!, { chosen: true });
      opened.push(chat.t.session.id);
      said.push(chat.shown().includes("can't be opened"));
      await Tui.leave(chat.t);
    }
    expect(opened[0]).not.toBe(bad.id);
    expect(opened[1]).toBe(opened[0]);
    expect(opened[2]).toBe(opened[0]);
    expect(said).toEqual([true, false, false]);
    expect(fs.readdirSync(Store.home(cwd)).length).toBe(2);
  });

  test("a session the user named that won't open still fails", async () => {
    const cwd = fresh();
    const bad = await older(cwd);
    garble(bad.dir);
    expect(() => started(bad)).toThrow("can't be opened");
    expect(fs.readdirSync(Store.home(cwd))).toEqual([bad.id]);
  });
});

describe("--import", () => {
  test("from the shell, one that won't open leaves no session and a next start isn't stuck", async () => {
    const cwd = fresh();
    const src = damaged_copy_of((await older(fresh())).dir);
    await expect(terminal(true, cwd, () => main(["--import", src]))).rejects.toThrow("can't be opened");
    expect(fs.readdirSync(Store.home(cwd))).toEqual([]);
    expect(Store.latest(cwd)).toBeNull();
  });

  test("with no terminal it stays imported and says what is needed", async () => {
    const cwd = fresh();
    const src = (await older(fresh())).dir;
    expect(await terminal(false, cwd, () => main(["--import", src]))).toBe(2);
    expect(Store.list(cwd).map((s) => s.from)).toEqual([src]);
  });
});

describe("--resume", () => {
  test("a latest session that won't open leaves the picker up, listing it", async () => {
    const cwd = fresh();
    const bad = await older(cwd);
    garble(bad.dir);
    const chat = started(Store.latest(cwd)!, { chosen: true, resume: true });
    expect(chat.t.menu).not.toBeNull();
    expect(chat.t.menu!.all.map((c) => c.value)).toContain(bad.dir);
    expect(chat.shown()).toContain("Sessions in");
    expect(chat.shown()).toContain("can't be opened");
    await Tui.leave(chat.t);
  });

  async function no_call(session: Session, chat: ReturnType<typeof started>, seen: number): Promise<void> {
    await Bun.sleep(100);
    expect(STUB.reqs.length, "no model request").toBe(seen);
    expect(chat.t.chat.busy, "no turn runs").toBe(false);
    expect(logged(session.dir)).not.toContain("unii restarted");
    expect(saved_work(session.dir)).toEqual([TURN]);
  }

  async function goes_on(session: Session, chat: ReturnType<typeof started>, seen: number): Promise<void> {
    await until(() => !chat.t.chat.busy && chat.shown().includes("went on"));
    expect(chat.t.session.id).toBe(session.id);
    expect(STUB.reqs.length).toBe(seen + 1);
    expect(logged(session.dir)).toContain("unii restarted");
    expect(chat.shown()).toContain("went on");
  }

  function choose(chat: ReturnType<typeof started>, dir: string): void {
    chat.t.menu!.at = chat.t.menu!.all.findIndex((c) => c.value === dir);
    Tui.input(chat.t, "\r");
  }

  const closes: Array<[string, string]> = [
    ["Esc", "\x1b"],
    ["Ctrl+C", "\x03"],
    ["Enter on this same session", "\r"],
  ];
  for (const [name, keys] of closes) {
    test("a cut turn waits for the picker, and goes on at " + name, async () => {
      STUB.script = () => [{ t: "text", x: "went on" }];
      const session = cut_turn(fresh());
      const seen = STUB.reqs.length;
      const chat = started(session, { chosen: true, resume: true });
      await no_call(session, chat, seen);
      Tui.input(chat.t, keys);
      await goes_on(session, chat, seen);
      await Tui.leave(chat.t);
    });
  }

  test("another session picked leaves the cut turn saved, for when its session opens", async () => {
    const cwd = fresh();
    const other = await older(cwd, "the other chat");
    STUB.script = () => [{ t: "text", x: "went on" }];
    Bun.sleepSync(5);
    const session = cut_turn(cwd);
    const seen = STUB.reqs.length;
    const chat = started(session, { chosen: true, resume: true });
    choose(chat, other.dir);
    await until(() => chat.t.session.id === other.id);
    expect(chat.t.session.id).toBe(other.id);
    expect(STUB.reqs.length).toBe(seen);
    expect(logged(session.dir)).not.toContain("unii restarted");
    expect(saved_work(session.dir)).toEqual([TURN]);
    await Tui.leave(chat.t);
    const again = started(Store.read(session.dir)!);
    await goes_on(session, again, seen);
    await Tui.leave(again.t);
  });

  test("a pick that won't open stays on this session, and the cut turn goes on", async () => {
    const cwd = fresh();
    const bad = await older(cwd, "the damaged chat");
    STUB.script = () => [{ t: "text", x: "went on" }];
    garble(bad.dir);
    Bun.sleepSync(5);
    const session = cut_turn(cwd);
    const seen = STUB.reqs.length;
    const chat = started(session, { chosen: true, resume: true });
    choose(chat, bad.dir);
    await goes_on(session, chat, seen);
    expect(chat.shown()).toContain("can't be opened");
    await Tui.leave(chat.t);
  });
});

describe("the last-resort handler", () => {
  async function run(fault: string, ...args: string[]) {
    const dir = fs.mkdtempSync(os.tmpdir() + "/unii-start-dir-") + "/not-made-yet";
    const preload = fs.mkdtempSync(os.tmpdir() + "/unii-start-fault-") + "/fault.ts";
    fs.writeFileSync(preload, "const { Store } = await import(" + JSON.stringify(path.join(import.meta.dir, "Store.ts")) + ");\n" + fault);
    const proc = Bun.spawn(["bun", "--preload=" + preload, import.meta.dir + "/unii.ts", ...args], { cwd: fresh(), env: { ...process.env, UNII_DIR: dir }, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    return { code: await proc.exited, stderr, log: dir + "/errors.log" };
  }

  test("a code bug at startup says where its stack is, and errors.log holds it", async () => {
    const { code, stderr, log } = await run("Store.latest = () => (undefined as any).planted_bug();");
    expect(code).toBe(1);
    expect(stderr).toContain("planted_bug");
    expect(stderr).toContain(log);
    const stack = fs.readFileSync(log, "utf8");
    expect(stack).toContain("TypeError");
    expect(stack).toContain("planted_bug");
    expect(stack).toContain("    at ");
  });

  test("an error the user can act on is its message alone, and logged", async () => {
    const { code, stderr, log } = await run("", "--import", "/nothing/here");
    expect(code).toBe(1);
    expect(stderr).toBe("unii: no chat to import at /nothing/here\n");
    expect(fs.readFileSync(log, "utf8")).toContain("no chat to import at /nothing/here");
  });
});

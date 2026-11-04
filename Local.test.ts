// Local test
// ==========
// `bun test Local.test.ts`. The harness's chat (Local.ts) on a stubbed
// wire (wire.stub.ts), through the real AskAI, Agent loop, Memory and
// Machine: a turn answers and is logged; tools run in the working dir; a
// message sent mid-turn reaches the model between tool calls, in the same
// turn; a stop ends a reply and a running command at once, its process
// group gone; a turn cut by a crash goes on as the chat opens again; a
// pick or goal that can't be saved stays as it was; summaries build in the
// background; a session that fails to open leaves no file open; what fails
// in a turn or a summary is logged with its stack in errors.log, a code
// bug's note says so, and the chat goes on.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { DIR } from "./scratch.stub.ts";

const { Local, TURN } = await import("./Local.ts");
const { AGAIN, Damaged, Memory } = await import("./Memory.ts");
const { STUB, stub_install, stub_remove } = await import("./wire.stub.ts");

type Hooks = import("./Local.ts").Hooks;

const CWD = fs.realpathSync(fs.mkdtempSync(os.tmpdir() + "/unii-cwd-"));
const LOG = DIR + "/errors.log";

function hooks(log: string[] = []): Hooks & { log: string[]; ends: boolean[]; faults: string[] } {
  const ends: boolean[] = [];
  const faults: string[] = [];
  return {
    log, ends, faults,
    entry : (m) => log.push(m.kind + ": " + m.text),
    live  : () => {},
    mind  : () => {},
    state : () => {},
    ended : (end) => ends.push(end.ok),
    fault : (why) => faults.push(why),
  };
}

function logged(): string {
  return fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8") : "";
}

// the next call of of[name] throws, and it is itself again
function plant(of: any, name: string, err: Error): void {
  const real = of[name];
  of[name] = () => {
    of[name] = real;
    throw err;
  };
}

async function idle(chat: { busy: boolean }, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (chat.busy && Date.now() < until) {
    await Bun.sleep(10);
  }
}

beforeAll(stub_install);
afterAll(stub_remove);

test("a turn answers, logged as it comes", async () => {
  STUB.script = () => [{ t: "text", x: "hello " }, { t: "text", x: "there" }];
  const h = hooks();
  const chat = Local.open(DIR + "/s1", CWD, h);
  Local.say(chat, "hi");
  expect(chat.busy).toBe(true);
  await idle(chat);
  expect(h.log).toEqual(["user: hi", "unii: hello there"]);
  expect(chat.mem.count).toBe(2);
  expect(chat.mem.work).toEqual([]);
  expect(STUB.reqs.at(-1)!.last).toContain("hi");
  expect(STUB.reqs.at(-1)!.tools).toEqual(["zoom", "date", "shell", "read", "write", "edit"]);
  await Local.close(chat);
});

test("tools run in the working dir; an edit answers its diff", async () => {
  fs.writeFileSync(CWD + "/a.txt", "one\ntwo\n");
  STUB.script = (req) => req.items.length === 1
    ? [{ t: "tool", id: "c1", name: "shell", input: { command: "pwd" } }, { t: "tool", id: "c2", name: "edit", input: { edits: [{ path: "a.txt", old: "two", new: "2" }] } }]
    : [{ t: "text", x: "done" }];
  const h = hooks();
  const chat = Local.open(DIR + "/s2", CWD, h);
  Local.say(chat, "go");
  await idle(chat);
  const echo = h.log.filter((l) => l.startsWith("echo: "));
  expect(echo[0]).toContain(CWD);
  expect(echo[1]).toContain("-two");
  expect(echo[1]).toContain("+2");
  expect(fs.readFileSync(CWD + "/a.txt", "utf8")).toBe("one\n2\n");
  expect(h.log.at(-1)).toBe("unii: done");
  await Local.close(chat);
});

test("a message sent mid-turn reaches the model between tool calls", async () => {
  STUB.script = (req) => {
    const said = JSON.stringify(req.items).includes("second");
    return said ? [{ t: "text", x: "got both" }] : [{ t: "tool", id: "s" + req.n, name: "shell", input: { command: "sleep 0.3" } }];
  };
  const h = hooks();
  const chat = Local.open(DIR + "/s3", CWD, h);
  Local.say(chat, "first");
  await Bun.sleep(100);
  Local.say(chat, "second");
  await idle(chat);
  expect(h.ends).toEqual([true]);
  expect(h.log.at(-1)).toBe("unii: got both");
  const last = STUB.reqs.at(-1)!;
  expect(last.items.map((i) => i.$)).toEqual(["User", "Turn", "Back", "User"]);
  await Local.close(chat);
});

test("a stop ends a reply streaming at once", async () => {
  STUB.script = () => [{ t: "text", x: "partial" }, { t: "wait", ms: 30000 }, { t: "text", x: "never" }];
  const h = hooks();
  const chat = Local.open(DIR + "/s4", CWD, h);
  Local.say(chat, "long reply");
  await Bun.sleep(150);
  const t0 = performance.now();
  Local.interrupt(chat, "Stopped by the user.");
  await idle(chat);
  expect(performance.now() - t0).toBeLessThan(1000);
  expect(h.log.join("\n")).toContain("partial");
  expect(h.log.join("\n")).not.toContain("never");
  expect(h.log.at(-1)).toBe("note: Stopped by the user.");
  await Local.close(chat);
});

test("a stop kills the running command's process group", async () => {
  const mark = "sleep 29." + String(Math.random()).slice(2, 8);
  STUB.script = (req) => req.items.length === 1 ? [{ t: "tool", id: "z", name: "shell", input: { command: mark + " && echo late" } }] : [{ t: "text", x: "after" }];
  const h = hooks();
  const chat = Local.open(DIR + "/s5", CWD, h);
  Local.say(chat, "sleep");
  await Bun.sleep(300);
  expect(Bun.spawnSync(["ps", "-axo", "command="]).stdout.toString()).toContain(mark);
  const t0 = performance.now();
  Local.interrupt(chat, "Stopped by the user.");
  await idle(chat);
  expect(performance.now() - t0).toBeLessThan(1000);
  await Bun.sleep(50);
  expect(Bun.spawnSync(["ps", "-axo", "command="]).stdout.toString()).not.toContain(mark);
  expect(h.log.some((l) => l.startsWith("echo: ") && l.includes("stopped"))).toBe(true);
  await Local.close(chat);
});

test("a turn a crash cut goes on as the chat opens again", async () => {
  STUB.script = () => [{ t: "text", x: "resumed" }];
  const dir = DIR + "/s6";
  const first = Local.open(dir, CWD, hooks());
  Memory.push(first.mem, [{ kind: "user", text: "unfinished" }]);
  first.mem.work = [TURN];
  Memory.save(first.mem);
  Memory.stop(first.mem);
  const h = hooks();
  const chat = Local.open(dir, CWD, h);
  expect(Local.resume(chat)).toBe(true);
  await idle(chat);
  expect(h.log[0]).toContain("note: unii restarted");
  expect(h.log.at(-1)).toBe("unii: resumed");
  expect(STUB.reqs.at(-1)!.last).toContain("restarted");
  expect(chat.mem.work).toEqual([]);
  await Local.close(chat);
});

test("a repick that can't be saved leaves the pick and view.json as they were", async () => {
  const dir = DIR + "/s-repick";
  const chat = Local.open(dir, CWD, hooks());
  const was = chat.pick;
  fs.chmodSync(dir, 0o555);
  expect(() => Local.repick(chat, { ...was, effort: "max" })).toThrow("EACCES");
  fs.chmodSync(dir, 0o755);
  expect(chat.pick).toEqual(was);
  expect(chat.mem.pick).toBe(null);
  Memory.save(chat.mem);
  expect(Memory.saved(dir)!.pick).toBe(null);
  await Local.close(chat);
});

test("a goal that can't be saved leaves the goal and view.json as they were", async () => {
  const dir = DIR + "/s-goal";
  const h = hooks();
  const chat = Local.open(dir, CWD, h);
  Local.goal(chat, "the first");
  fs.chmodSync(dir, 0o555);
  expect(() => Local.goal(chat, "the second")).toThrow("EACCES");
  expect(() => Local.goal(chat, null)).toThrow("EACCES");
  fs.chmodSync(dir, 0o755);
  expect(chat.mem.goal).toBe("the first");
  expect(h.log).toEqual([]);
  Memory.save(chat.mem);
  expect(Memory.saved(dir)!.goal).toBe("the first");
  await Local.close(chat);
});

test("summaries build in the background", async () => {
  STUB.script = () => [{ t: "text", x: "fine" }];
  const chat = Local.open(DIR + "/s7", CWD, hooks());
  Memory.push(chat.mem, Array.from({ length: 6 }, (_, k) => ({ kind: "user" as const, text: k + " " + "word ".repeat(200) })));
  const until = Date.now() + 5000;
  while (Memory.first(chat.mem) < 6 && Date.now() < until) {
    await Bun.sleep(10);
  }
  expect(Memory.first(chat.mem)).toBe(6);
  expect(Memory.node(chat.mem, { l: 0, i: 0 })).toStartWith("line: Compaction");
  await Local.close(chat);
});

test("a session that fails to open leaves no file open, however many times it is tried", async () => {
  STUB.script = () => [{ t: "text", x: "fine" }];
  const dir = DIR + "/s8";
  const first = Local.open(dir, CWD, hooks());
  Local.say(first, "a message");
  await idle(first);
  await Local.close(first);
  const file = dir + "/main/" + fs.readdirSync(dir + "/main")[0];
  const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  lines[lines.length - 1] = "x".repeat(lines.at(-1)!.length);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const open = () => fs.readdirSync("/dev/fd").length;
  const before = open();
  for (let k = 0; k < 50; k++) {
    expect(() => Local.open(dir, CWD, hooks())).toThrow(Damaged);
  }
  expect(open()).toBeLessThanOrEqual(before);
});

test("a code bug in a turn says so in its note, errors.log holds its stack, and the next message is answered", async () => {
  STUB.script = () => [{ t: "text", x: "fine" }];
  const h = hooks();
  const chat = Local.open(DIR + "/s9", CWD, h);
  plant(Local, "tools", new TypeError("planted in a turn"));
  Local.say(chat, "one");
  await idle(chat);
  const note = h.log.at(-1)!;
  expect(note).toStartWith("note: No reply: planted in a turn");
  expect(note).toContain("a bug in unii");
  expect(note).toContain(LOG);
  expect(logged()).toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z\nTypeError: planted in a turn\n/);
  expect(logged()).toContain("Local.test.ts");
  expect(fs.statSync(LOG).mode & 0o777).toBe(0o600);
  Local.say(chat, "two");
  await idle(chat);
  expect(h.log.at(-1)).toBe("unii: fine");
  await Local.close(chat);
});

test("a plain error in a turn keeps its note as it was, and is logged", async () => {
  const h = hooks();
  const chat = Local.open(DIR + "/s10", CWD, h);
  plant(Local, "tools", new Error("planted plain"));
  Local.say(chat, "one");
  await idle(chat);
  expect(h.log.at(-1)).toBe("note: No reply: planted plain. Send a message to try again.");
  expect(logged()).toContain("Error: planted plain\n");
  await Local.close(chat);
});

test("a disk error in a turn keeps its note as it was, is logged, and the chat goes on", async () => {
  STUB.script = () => [{ t: "text", x: "fine" }];
  const h = hooks();
  const chat = Local.open(DIR + "/s11", CWD, h);
  plant(Memory, "settle", Object.assign(new Error("EACCES: permission denied, open 'the disk'"), { code: "EACCES" }));
  Local.say(chat, "one");
  await idle(chat);
  const note = h.log.at(-1)!;
  expect(note).toBe("note: No reply: EACCES: permission denied, open 'the disk'. Send a message to try again.");
  expect(logged()).toContain("open 'the disk'");
  Local.say(chat, "two");
  await idle(chat);
  expect(h.log.at(-1)).toBe("unii: fine");
  await Local.close(chat);
});

test("a save refused as a turn ends reaches the terminal as it is, is logged, and the chat goes on as the disk comes back", async () => {
  STUB.script = (req) => [{ t: "wait", ms: req.last.includes("one") ? 150 : 0 }, { t: "text", x: "fine" }];
  const h = hooks();
  const dir = DIR + "/s15";
  const chat = Local.open(dir, CWD, h);
  Local.say(chat, "one");
  fs.chmodSync(dir, 0o555);
  await idle(chat);
  await Bun.sleep(20);
  fs.chmodSync(dir, 0o755);
  expect(h.faults).toHaveLength(1);
  expect(h.faults[0]).toStartWith("EACCES");
  expect(h.faults[0]).not.toContain("a bug in unii");
  expect(logged()).toContain(dir + "/view.json");
  Local.say(chat, "two");
  await idle(chat);
  expect(h.log.at(-1)).toBe("unii: fine");
  await Local.close(chat);
});

test("a code bug as a turn ends reaches the terminal as a bug, with its stack in errors.log", async () => {
  STUB.script = () => [{ t: "text", x: "fine" }];
  const h = hooks();
  const chat = Local.open(DIR + "/s12", CWD, h);
  const change = Local.change;
  (Local as any).change = (c: typeof chat) => {
    if (!c.busy) {
      (Local as any).change = change;
      throw new TypeError("planted as a turn ends");
    }
    return change(c);
  };
  Local.say(chat, "one");
  await idle(chat);
  await Bun.sleep(20);
  expect(h.faults).toHaveLength(1);
  expect(h.faults[0]).toContain("planted as a turn ends");
  expect(h.faults[0]).toContain("a bug in unii");
  expect(h.faults[0]).toContain(LOG);
  expect(logged()).toContain("TypeError: planted as a turn ends\n");
  Local.say(chat, "two");
  await idle(chat);
  expect(h.log.at(-1)).toBe("unii: fine");
  await Local.close(chat);
});

test("a summary's code bug is in errors.log with its stack, and a later try still builds it", async () => {
  const chat = Local.open(DIR + "/s13", CWD, hooks());
  plant(Memory, "ask", new TypeError("planted in a summary"));
  Memory.push(chat.mem, Array.from({ length: 4 }, (_, k) => ({ kind: "user" as const, text: k + " " + "word ".repeat(2000) })));
  const until = Date.now() + AGAIN + 5000;
  while (Memory.first(chat.mem) < 4 && Date.now() < until) {
    await Bun.sleep(10);
  }
  expect(logged()).toContain("TypeError: planted in a summary\n");
  expect(Memory.first(chat.mem)).toBe(4);
  await Local.close(chat);
}, AGAIN + 10000);

test("a summary that keeps failing tells its reason once, lets the terminal run, and builds once it can", async () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(os.tmpdir() + "/unii-summary-cwd-"));
  fs.mkdirSync(cwd + "/AGENTS.md");
  const told = () => logged().split("EISDIR").length - 1;
  const before = told();
  const chat = Local.open(DIR + "/s16", cwd, hooks());
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  Memory.push(chat.mem, Array.from({ length: 4 }, (_, k) => ({ kind: "user" as const, text: k + " " + "word ".repeat(200) })));
  await Bun.sleep(500);
  clearInterval(timer);
  expect(ticks, "the event loop runs while it fails").toBeGreaterThan(10);
  expect(told() - before, "told once").toBe(1);
  fs.rmdirSync(cwd + "/AGENTS.md");
  const until = Date.now() + AGAIN + 5000;
  while (Memory.first(chat.mem) < 4 && Date.now() < until) {
    await Bun.sleep(10);
  }
  expect(Memory.first(chat.mem)).toBe(4);
  await Local.close(chat);
}, AGAIN + 10000);

test("summaries a stop cuts are no errors", async () => {
  const chat = Local.open(DIR + "/s14", CWD, hooks());
  Memory.push(chat.mem, Array.from({ length: 4 }, (_, k) => ({ kind: "user" as const, text: k + " " + "word ".repeat(2000) })));
  expect(chat.mem.calls.size).toBeGreaterThan(0);
  const before = logged();
  await Local.close(chat);
  const until = Date.now() + 5000;
  while (chat.mem.busy.size > 0 && Date.now() < until) {
    await Bun.sleep(5);
  }
  await Bun.sleep(20);
  expect(chat.mem.busy.size).toBe(0);
  expect(logged()).toBe(before);
});

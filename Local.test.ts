// Local test
// ==========
// `bun test Local.test.ts`. The harness's chat (Local.ts) on a stubbed
// wire (wire.stub.ts), through the real AskAI, Agent loop, Memory and
// Machine: a turn answers and is logged; tools run in the working dir; a
// message sent mid-turn reaches the model between tool calls, in the same
// turn; a stop ends a reply and a running command at once, its process
// group gone; a turn cut by a crash goes on as the chat opens again;
// summaries build in the background.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

const DIR = fs.mkdtempSync(os.tmpdir() + "/unii-local-");
process.env.UNII_DIR = DIR;

const { Local, TURN } = await import("./Local.ts");
const { Memory } = await import("./Memory.ts");
const { STUB, stub_install, stub_remove } = await import("./wire.stub.ts");

type Hooks = import("./Local.ts").Hooks;

const CWD = fs.realpathSync(fs.mkdtempSync(os.tmpdir() + "/unii-cwd-"));

function hooks(log: string[] = []): Hooks & { log: string[]; ends: boolean[] } {
  const ends: boolean[] = [];
  return {
    log, ends,
    entry : (m) => log.push(m.kind + ": " + m.text),
    live  : () => {},
    mind  : () => {},
    state : () => {},
    ended : (end) => ends.push(end.ok),
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

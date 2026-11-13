// Store test
// ==========
// `bun test Store.test.ts`. Sessions kept by working directory, and the
// import of a chat the server kept: on a copy of a real one (work/
// data-copy/users/1, when there; else a chat made here), copied again so
// the test never touches the first copy. The session gets its history
// and memory tree, the source's files stay byte for byte as they were, a
// turn on the session goes on from the imported chat, a session open in
// another live unii is not the one `latest` gives, an import a kill cuts
// leaves nothing a next start doesn't remove.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DIR } from "./scratch.stub.ts";

const { Store } = await import("./Store.ts");
const { Local } = await import("./Local.ts");
const { STUB, stub_install, stub_remove } = await import("./wire.stub.ts");

const CWD = fs.realpathSync(fs.mkdtempSync(os.tmpdir() + "/unii-store-cwd-"));
const COPY = path.join(import.meta.dir, "../work/data-copy/users/1");
const SRC = DIR + "/users/1";

const hooks = { entry: () => {}, live: () => {}, mind: () => {}, state: () => {}, ended: () => {}, fault: () => {}, summary: () => {} };

function sums(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d)) {
      const p = d + "/" + name;
      if (fs.statSync(p).isDirectory()) {
        walk(p);
      } else {
        out[path.relative(dir, p)] = new Bun.CryptoHasher("sha256").update(fs.readFileSync(p)).digest("hex");
      }
    }
  };
  walk(dir);
  return out;
}

beforeAll(async () => {
  stub_install();
  if (fs.existsSync(COPY)) {
    fs.cpSync(COPY, SRC, { recursive: true });
    return;
  }
  STUB.script = () => [{ t: "text", x: "made here" }];
  const chat = Local.open(SRC, CWD, hooks);
  Local.say(chat, "a chat to import");
  while (chat.busy) {
    await Bun.sleep(10);
  }
  await Local.close(chat);
});
afterAll(stub_remove);

test("an import brings the history and tree; the source stays as it was", async () => {
  const before = sums(SRC);
  // read as files: a Memory.load would write the source's view
  const count = fs.statSync(SRC + "/main.index").size / 16;
  const parts = JSON.parse(fs.readFileSync(SRC + "/view.json", "utf8")).parts.length;
  const last = Store.last(SRC)!.text;
  const s = Store.bring(SRC, CWD);
  expect(s.from).toBe(SRC);
  expect(s.count).toBe(count);
  STUB.script = () => [{ t: "text", x: "carried on" }];
  const seen: string[] = [];
  const chat = Local.open(s.dir, CWD, { ...hooks, entry: (m) => seen.push(m.kind + ": " + m.text) });
  expect(chat.mem.count).toBe(count);
  expect(chat.mem.view.parts.length).toBe(parts);
  expect(Local.tail(chat, 5).at(-1)!.text).toBe(last);
  Local.say(chat, "go on");
  while (chat.busy) {
    await Bun.sleep(10);
  }
  expect(seen.at(-1)).toBe("unii: carried on");
  expect(chat.mem.count).toBe(count + 2);
  await Local.close(chat);
  expect(sums(SRC)).toEqual(before);
});

test("latest: the newest session no live unii holds, print runs aside", () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(os.tmpdir() + "/unii-store-cwd2-"));
  const a = Store.make(cwd);
  Bun.sleepSync(5);
  const b = Store.make(cwd);
  Bun.sleepSync(5);
  Store.make(cwd, undefined, true);
  expect(Store.latest(cwd)!.id).toBe(b.id);
  const held = Bun.spawn(["sleep", "5"]);
  fs.writeFileSync(b.dir + "/lock", String(held.pid));
  expect(Store.latest(cwd)!.id).toBe(a.id);
  held.kill();
  expect(Store.lock(a.dir)).toBe(true);
  Store.unlock(a.dir);
  expect(fs.existsSync(a.dir + "/lock")).toBe(false);
});

function stale_copy(home: string, name: string): string {
  const dir = home + "/" + name;
  fs.mkdirSync(dir + "/main", { recursive: true });
  fs.writeFileSync(dir + "/main/2026-01-01.jsonl", "half a copy");
  return dir;
}

test("an import killed mid-copy leaves nothing once the next unii starts", async () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(os.tmpdir() + "/unii-store-cwd3-"));
  const big = DIR + "/big";
  fs.cpSync(SRC, big, { recursive: true });
  fs.mkdirSync(big + "/docs", { recursive: true });
  for (let k = 0; k < 6000; k++) {
    fs.writeFileSync(big + "/docs/f" + k, "x".repeat(256));
  }
  const unii = (...args: string[]) => Bun.spawn(["bun", import.meta.dir + "/unii.ts", ...args], { cwd, env: { ...process.env, UNII_DIR: DIR }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const home = Store.home(cwd);
  const entries = () => (fs.existsSync(home) ? fs.readdirSync(home) : []);
  const copying = unii("--import", big);
  while (entries().length === 0 && copying.exitCode === null) {
    await Bun.sleep(1);
  }
  copying.kill(9);
  await copying.exited;
  expect(copying.signalCode, "the copy was still running when it was killed").toBe("SIGKILL");
  expect(entries().length, "the kill left the copy behind").toBe(1);
  expect(Store.list(cwd), "a cut copy is no session").toEqual([]);
  expect(await unii("--new").exited, "no terminal: the session made and no chat").toBe(2);
  const sessions = Store.list(cwd).map((s) => s.id);
  expect(sessions.length).toBe(1);
  expect(entries(), "the next start removed the copy").toEqual(sessions);
});

test("an import removes dead imports' copies only: a live one's, and any other dir, stay", () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(os.tmpdir() + "/unii-store-cwd4-"));
  const home = Store.home(cwd);
  const live = Bun.spawn(["sleep", "5"]);
  const dead = stale_copy(home, "dead.999999.part");
  const unnamed = stale_copy(home, "unnamed.part");
  const running = stale_copy(home, "running." + live.pid + ".part");
  const other = stale_copy(home, "no-meta-yet");
  Store.bring(SRC, cwd);
  live.kill();
  expect(fs.existsSync(dead), "a dead pid's copy").toBe(false);
  expect(fs.existsSync(unnamed), "a copy naming no pid").toBe(false);
  expect(fs.existsSync(running), "a live pid's copy").toBe(true);
  expect(fs.existsSync(other), "a dir not named .part").toBe(true);
});

test("a whole copy killed just before its rename is no session", () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(os.tmpdir() + "/unii-store-cwd5-"));
  const part = stale_copy(Store.home(cwd), "2026-01-01T00-00-00-000-abcd.999999.part");
  fs.writeFileSync(part + "/meta.json", JSON.stringify({ cwd, made: new Date().toISOString() }));
  expect(Store.list(cwd)).toEqual([]);
  expect(Store.latest(cwd)).toBeNull();
});

test("an import comes whole under its id, unlocked, with no copy left beside it", () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(os.tmpdir() + "/unii-store-cwd6-"));
  const s = Store.bring(SRC, cwd);
  expect(fs.readdirSync(Store.home(cwd))).toEqual([s.id]);
  expect(s.dir).toBe(Store.home(cwd) + "/" + s.id);
  expect(fs.existsSync(s.dir + "/lock")).toBe(false);
  expect(Store.latest(cwd)!.id).toBe(s.id);
  expect(Store.read(s.dir)!.count).toBe(s.count);
});

test("an empty lock holds nothing, as its writer died writing it", () => {
  const s = Store.make(fs.realpathSync(fs.mkdtempSync(os.tmpdir() + "/unii-store-cwd7-")));
  fs.writeFileSync(s.dir + "/lock", "");
  expect(Store.holder(s.dir)).toBeNull();
});

test("a session's count of lines is whole, whatever its index holds", () => {
  const s = Store.make(fs.realpathSync(fs.mkdtempSync(os.tmpdir() + "/unii-store-cwd8-")));
  fs.writeFileSync(s.dir + "/main.index", Buffer.alloc(37, 1));
  expect(Store.read(s.dir)!.count).toBe(2);
});

test("a failed copy leaves nothing", () => {
  if (process.getuid?.() === 0) {
    return;
  }
  const cwd = fs.realpathSync(fs.mkdtempSync(os.tmpdir() + "/unii-store-cwd7-"));
  const src = fs.mkdtempSync(os.tmpdir() + "/unii-store-src-");
  fs.writeFileSync(src + "/main.index", "");
  fs.mkdirSync(src + "/docs");
  fs.writeFileSync(src + "/docs/secret", "x");
  fs.chmodSync(src + "/docs/secret", 0o000);
  expect(() => Store.bring(src, cwd)).toThrow();
  expect(fs.readdirSync(Store.home(cwd))).toEqual([]);
  fs.chmodSync(src + "/docs/secret", 0o600);
});

test("a dead import's copy that can't be removed stops no import, and is logged", () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(os.tmpdir() + "/unii-store-cwd8-"));
  const stuck = stale_copy(Store.home(cwd), "stuck.999999.part");
  fs.chmodSync(stuck + "/main", 0o555);
  const s = Store.bring(SRC, cwd);
  expect(Store.latest(cwd)!.id).toBe(s.id);
  if (process.getuid?.() !== 0) {
    expect(fs.readFileSync(DIR + "/errors.log", "utf8")).toContain(stuck);
  }
  fs.chmodSync(stuck + "/main", 0o755);
});

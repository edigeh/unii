// Store test
// ==========
// `bun test Store.test.ts`. Sessions kept by working directory, and the
// import of a chat the server kept: on a copy of a real one (work/
// data-copy/users/1, when there; else a chat made here), copied again so
// the test never touches the first copy. The session gets its history
// and memory tree, the source's files stay byte for byte as they were, a
// turn on the session goes on from the imported chat, a session open in
// another live unii is not the one `latest` gives.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DIR = fs.mkdtempSync(os.tmpdir() + "/unii-store-");
process.env.UNII_DIR = DIR;

const { Store } = await import("./Store.ts");
const { Local } = await import("./Local.ts");
const { STUB, stub_install, stub_remove } = await import("./wire.stub.ts");

const CWD = fs.realpathSync(fs.mkdtempSync(os.tmpdir() + "/unii-store-cwd-"));
const COPY = path.join(import.meta.dir, "work/data-copy/users/1");
const SRC = DIR + "/users/1";

const hooks = { entry: () => {}, live: () => {}, mind: () => {}, state: () => {}, ended: () => {} };

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

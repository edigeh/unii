// Crash test
// ==========
// `bun test Crash.test.ts`. A real unii process, on a stubbed wire, crashes
// while its shell tool runs a job: the job dies with it, the crash shows,
// the exit code is 1, and the chat gives its terminal back.

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { Machine } from "./Machine.ts";

const ROOT = import.meta.dir;
const DIR = fs.realpathSync(fs.mkdtempSync(os.tmpdir() + "/unii-crash-"));
const PRELOAD = DIR + "/crash.preload.ts";
const PASTE_OFF = "\x1b[?2004l";

fs.writeFileSync(PRELOAD, `
import * as fs from "node:fs";
import { STUB, stub_install } from ${JSON.stringify(ROOT + "/wire.stub.ts")};
stub_install();
STUB.script = (req) => req.items.length === 1
  ? [{ t: "tool", id: "job", name: "shell", input: { command: process.env.JOB } }]
  : [{ t: "text", x: "ran it" }];
const timer = setInterval(() => {
  if (!fs.existsSync(process.env.PID_FILE)) {
    return;
  }
  clearInterval(timer);
  if (process.env.NO_CRASH) {
    return;
  }
  if (process.env.PS_FAILS) {
    Bun.spawnSync = () => {
      throw new Error("ps failed");
    };
  }
  if (process.env.REJECT) {
    Promise.reject(new Error("the crash"));
  } else {
    throw new Error("the crash");
  }
}, 20);
`);

afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

type Case = { cwd: string; pid_file: string; env: Record<string, string> };

function scratch(name: string, extra: Record<string, string> = {}): Case {
  const dir = DIR + "/" + name;
  fs.mkdirSync(dir + "/home", { recursive: true });
  fs.mkdirSync(dir + "/cwd");
  const pid_file = dir + "/job.pid";
  return {
    cwd: dir + "/cwd",
    pid_file,
    env: {
      PATH     : process.env.PATH ?? "",
      HOME     : dir + "/home",
      UNII_DIR : dir + "/unii",
      SHELL    : "/bin/sh",
      TERM     : "xterm-256color",
      PID_FILE : pid_file,
      JOB      : `echo $$ > "$PID_FILE.tmp"; mv "$PID_FILE.tmp" "$PID_FILE"; exec sleep 300`,
      ...extra,
    },
  };
}

async function until(ok: () => boolean, why: string, ms = 10000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) {
      throw new Error("timed out waiting: " + why);
    }
    await Bun.sleep(20);
  }
}

async function job_outlived(pid_file: string): Promise<boolean> {
  const pid = Number(fs.readFileSync(pid_file, "utf8").trim());
  const end = Date.now() + 1500;
  while (Machine.alive(pid) && Date.now() < end) {
    await Bun.sleep(20);
  }
  const alive = Machine.alive(pid);
  if (alive) {
    Machine.kill(pid);
  }
  return alive;
}

async function crash_in_terminal(c: Case): Promise<{ code: number; out: string; outlived: boolean }> {
  let out = "";
  const text = new TextDecoder();
  const proc = Bun.spawn([process.execPath, "--preload=" + PRELOAD, ROOT + "/unii.ts", "--new"], {
    cwd: c.cwd,
    env: c.env,
    terminal: { cols: 120, rows: 40, data: (_, chunk) => { out += text.decode(chunk); } },
  });
  await until(() => out.includes("message unii"), "the editor's prompt");
  proc.terminal!.write("go");
  await Bun.sleep(100);
  proc.terminal!.write("\r");
  await until(() => fs.existsSync(c.pid_file), "the job's pid");
  const code = await proc.exited;
  await until(() => out.includes("the crash"), "the crash on the terminal", 2000).catch(() => {});
  proc.terminal!.close();
  return { code, out, outlived: await job_outlived(c.pid_file) };
}

async function crash_in_print(c: Case): Promise<{ code: number; err: string; outlived: boolean }> {
  const proc = Bun.spawn([process.execPath, "--preload=" + PRELOAD, ROOT + "/unii.ts", "-p", "go"], {
    cwd: c.cwd,
    env: c.env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const err = new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, err: await err, outlived: await job_outlived(c.pid_file) };
}

test("a crash in the chat kills the running job, shows its stack on the given-back terminal, exits 1", async () => {
  const c = scratch("chat");
  const { code, out, outlived } = await crash_in_terminal(c);
  expect(fs.readFileSync(c.env.UNII_DIR + "/errors.log", "utf8"), "the stack kept").toContain("Error: the crash");
  expect(outlived, "the job outlived the crash").toBe(false);
  expect(code).toBe(1);
  expect(out).toContain("unii: Error: the crash");
  expect(out.indexOf(PASTE_OFF), "the terminal given back before the stack").toBeLessThan(out.indexOf("unii: Error: the crash"));
  expect(out.indexOf(PASTE_OFF), "the terminal given back").toBeGreaterThan(-1);
}, 30000);

test("an unhandled rejection in the chat kills the running job and exits 1", async () => {
  const { code, out, outlived } = await crash_in_terminal(scratch("chat-reject", { REJECT: "1" }));
  expect(outlived, "the job outlived the crash").toBe(false);
  expect(code).toBe(1);
  expect(out).toContain("unii: Error: the crash");
}, 30000);

test("a chat crash whose process listing fails still gives the terminal back, shows the stack, exits 1", async () => {
  const { code, out, outlived } = await crash_in_terminal(scratch("chat-ps", { PS_FAILS: "1" }));
  expect(code).toBe(1);
  expect(out).toContain("unii: Error: the crash");
  expect(out.indexOf(PASTE_OFF), "the terminal given back").toBeGreaterThan(-1);
  expect(outlived, "the job's group killed before the listing failed").toBe(false);
}, 30000);

test("a crash in print mode kills the running job, shows the error, exits 1", async () => {
  const { code, err, outlived } = await crash_in_print(scratch("print"));
  expect(outlived, "the job outlived the crash").toBe(false);
  expect(code).toBe(1);
  expect(err).toContain("the crash");
}, 30000);

test("an unhandled rejection in print mode kills the running job, shows the error, exits 1", async () => {
  const { code, err, outlived } = await crash_in_print(scratch("print-reject", { REJECT: "1" }));
  expect(outlived, "the job outlived the crash").toBe(false);
  expect(code).toBe(1);
  expect(err).toContain("the crash");
}, 30000);

test("a print-mode crash whose process listing fails still shows the error and exits 1", async () => {
  const { code, err, outlived } = await crash_in_print(scratch("print-ps", { PS_FAILS: "1" }));
  expect(code).toBe(1);
  expect(err).toContain("the crash");
  expect(outlived, "the job's group killed before the listing failed").toBe(false);
}, 30000);

test("print mode whose terminal closes kills the running job and exits 1", async () => {
  const c = scratch("print-hup", { NO_CRASH: "1" });
  const proc = Bun.spawn([process.execPath, "--preload=" + PRELOAD, ROOT + "/unii.ts", "-p", "go"], {
    cwd: c.cwd,
    env: c.env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await until(() => fs.existsSync(c.pid_file), "the job's pid");
  proc.kill("SIGHUP");
  const code = await proc.exited;
  expect(await job_outlived(c.pid_file), "the job outlived the hangup").toBe(false);
  expect(code).toBe(1);
}, 30000);

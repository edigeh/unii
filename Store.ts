// Store
// =====
// The harness's chats (sessions), kept by working directory under
// config.DIR/sessions/<dir's key>/<id>/: each a chat's memory (Memory.ts
// files: main/, tree/, their indexes, view.json, docs/) and meta.json, its
// working dir and where it came from. A session open in a unii holds its
// lock (its pid), so two never write one chat. An import copies a chat
// the server kept (config.DIR/users/<id>) into a new session, reading the
// source only, so its history and memory tree carry over and the server's
// stay as they were.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as config from "./Config.ts";
import { Memory } from "./Memory.ts";

// Types
// =====

// a session: its id, dir, working dir; made: when; from: the chat it was
// imported from, if one; print: a print mode run's (`unii -p`), which
// `unii` doesn't go on with; last: its last message's date, kind and
// text (none: empty); count: its lines logged
export type Session = {
  id    : string;
  dir   : string;
  cwd   : string;
  made  : string;
  from? : string;
  print : boolean;
  last  : { date: string; kind: string; text: string } | null;
  count : number;
  time  : number;
};

// Constants
// =========

export const ROOT = config.DIR + "/sessions";

// the errors Store.log_error keeps; its dir holds auth.json, so the owner's alone
export const ERRORS = config.DIR + "/errors.log";

// a chat's files an import copies (up/, posts' bodies, never: they are
// unlinked once open)
const FILES = ["main", "tree", "main.index", "tree.index", "view.json", "docs", "import.json"];

// the bytes read from a log's end to find its last message
const TAIL = 65536;

// a log's index, as Memory.ts writes it: a slot for each line, its byte at
// 0, its day at 8 (0: no line), its length at 12
const SLOT = 16;
const DAY  = 864e5;

// Store
// =====

export namespace Store {

  // a working dir's key: its path, readable, and a hash so two never share
  export function key(cwd: string): string {
    const name = cwd.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-80) || "root";
    return name + "-" + Bun.hash(cwd).toString(16).slice(0, 8);
  }

  export function home(cwd: string): string {
    return ROOT + "/" + Store.key(cwd);
  }

  // a new session's id: when, then a few random letters, so ids sort by age
  export function id(): string {
    return new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "") + "-" + crypto.randomUUID().slice(0, 4);
  }

  export function make(cwd: string, from?: string, print = false): Session {
    const dir = Store.home(cwd) + "/" + Store.id();
    fs.mkdirSync(dir, { recursive: true });
    return Store.stamp(dir, cwd, from, print);
  }

  // meta.json written: till then no list sees the dir as a session
  export function stamp(dir: string, cwd: string, from?: string, print = false): Session {
    const meta = { cwd, made: new Date().toISOString(), from, print: print || undefined };
    fs.writeFileSync(dir + "/meta.json", JSON.stringify(meta, null, 2) + "\n");
    const session = Store.read(dir);
    if (session === null) {
      throw new Error("the session at " + dir + " can't be read");
    }
    return session;
  }

  // a session's dir read; null: none there
  export function read(dir: string): Session | null {
    try {
      const meta = JSON.parse(fs.readFileSync(dir + "/meta.json", "utf8"));
      const index = dir + "/main.index";
      const count = fs.existsSync(index) ? fs.statSync(index).size / SLOT : 0;
      const time = fs.existsSync(index) ? fs.statSync(index).mtimeMs : fs.statSync(dir + "/meta.json").mtimeMs;
      return { id: path.basename(dir), dir, cwd: meta.cwd, made: meta.made, from: meta.from, print: meta.print === true, last: Store.last(dir), count, time };
    } catch {
      return null;
    }
  }

  // a working dir's sessions, the latest first
  export function list(cwd: string): Session[] {
    const home = Store.home(cwd);
    const ids = fs.existsSync(home) ? fs.readdirSync(home) : [];
    const all = ids.map((id) => Store.read(home + "/" + id)).filter((s): s is Session => s !== null);
    return all.sort((a, b) => b.time - a.time);
  }

  // the last message of a session's log: the end of its last day's file
  export function last(dir: string): Session["last"] {
    const days = fs.existsSync(dir + "/main") ? fs.readdirSync(dir + "/main").sort() : [];
    for (const day of days.reverse()) {
      const file = dir + "/main/" + day;
      const size = fs.statSync(file).size;
      const fd = fs.openSync(file, "r");
      try {
        const n = Math.min(size, TAIL);
        const buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, size - n);
        const lines = buf.toString("utf8").split("\n").reverse();
        for (const line of lines) {
          try {
            const rec = JSON.parse(line);
            if (rec.i !== undefined && typeof rec.text === "string") {
              return { date: rec.date, kind: rec.kind, text: rec.text };
            }
          } catch {}
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    return null;
  }

  // the latest session of a working dir no other unii holds, print mode's
  // aside; null: none
  export function latest(cwd: string): Session | null {
    return Store.list(cwd).find((s) => !s.print && Store.holder(s.dir) === null) ?? null;
  }

  // an error's time and stack, and its cause's, appended to ERRORS; false:
  // it can't be written, and the caller still has the error to report
  export function log_error(err: any): boolean {
    const stacks = [err, ...(err?.cause === undefined ? [] : [err.cause])].map((e) => String(e?.stack ?? e));
    try {
      fs.appendFileSync(ERRORS, new Date().toISOString() + "\n" + stacks.join("\n") + "\n\n", { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  // an error of the system (ENOENT, EACCES): it says what to fix. ERR_ codes
  // are Node's own, for a bad value passed: a code bug
  export function system(err: any): boolean {
    return typeof err?.code === "string" && /^E(?!RR_)[A-Z]/.test(err.code);
  }

  // an error a chat goes on from, logged: what its note says. A code bug's
  // says so, and where its stack went
  export function report(err: any): string {
    const logged = Store.log_error(err);
    const text = String(err?.message ?? err);
    const actionable = err instanceof Error && err.name === "Error" || Store.system(err);
    return actionable ? text : text + " (a bug in unii" + (logged ? "; its stack is in " + Store.tilde(ERRORS) : "") + ")";
  }

  // a path as the user writes it, under ~
  export function tilde(p: string): string {
    const h = os.homedir();
    return p === h ? "~" : p.startsWith(h + "/") ? "~" + p.slice(h.length) : p;
  }

  // Locks
  // -----

  // the pid of the live unii holding a session; null: none (a lock a
  // killed one left is stale)
  export function holder(dir: string): number | null {
    try {
      const pid = Number(fs.readFileSync(dir + "/lock", "utf8"));
      if (pid === process.pid) {
        return null;
      }
      process.kill(pid, 0);
      return pid;
    } catch (err: any) {
      return err?.code === "EPERM" ? -1 : null;
    }
  }

  // false: another unii holds it
  export function lock(dir: string): boolean {
    if (Store.holder(dir) !== null) {
      return false;
    }
    fs.writeFileSync(dir + "/lock", String(process.pid));
    return true;
  }

  export function unlock(dir: string): void {
    try {
      if (Number(fs.readFileSync(dir + "/lock", "utf8")) === process.pid) {
        fs.rmSync(dir + "/lock");
      }
    } catch {}
  }

  // Import
  // ------

  // the server's chat at `src` (a users/<id> dir) copied into a new
  // session of `cwd`; the source is only read. Throws if it holds no chat
  // or a damaged one. Its meta.json comes last and a failed copy is removed,
  // so a list never sees it half made, even if a crash cuts the copy
  export function bring(src: string, cwd: string): Session {
    if (!fs.existsSync(src + "/main.index")) {
      throw new Error("no chat to import at " + src);
    }
    const flaw = Store.flaw(src);
    if (flaw !== null) {
      throw new Error("no chat to import at " + src + ": " + flaw);
    }
    const dir = Store.home(cwd) + "/" + Store.id();
    fs.mkdirSync(dir, { recursive: true });
    try {
      for (const name of FILES.filter((name) => fs.existsSync(src + "/" + name))) {
        fs.cpSync(src + "/" + name, dir + "/" + name, { recursive: true, preserveTimestamps: true });
      }
      return Store.stamp(dir, cwd, src);
    } catch (err) {
      Store.drop(dir);
      throw err;
    }
  }

  // a session that holds nothing yet, removed
  export function drop(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // what is wrong with a chat's logs at `dir`, read as Memory.ts reads them:
  // view.json is a file; a saved end is within its day's file; an index a
  // load keeps (Memory.index makes anew one with no saved end) is whole
  // slots, each within its day's file. Its lines aren't parsed: one that is
  // no JSON is Damaged when read. null: nothing
  export function flaw(dir: string): string | null {
    if (fs.existsSync(dir + "/view.json") && !fs.statSync(dir + "/view.json").isFile()) {
      return "view.json is not a file";
    }
    const saved = Memory.saved(dir);
    for (const log of ["main", "tree"] as const) {
      const file = dir + "/" + log + ".index";
      if (!fs.existsSync(file)) {
        continue;
      }
      if (!fs.statSync(file).isFile()) {
        return log + ".index is not a file";
      }
      if (fs.existsSync(dir + "/" + log) && !fs.statSync(dir + "/" + log).isDirectory()) {
        return log + " is not a directory";
      }
      const end = saved?.[log] ?? [0, 0];
      if (end[0] === 0) {
        continue;
      }
      const ends = Store.day_size(dir + "/" + log, end[0]);
      if (ends !== -1 && !(end[1] >= 0 && end[1] <= ends)) {
        return log + " ends before the end view.json saved for it";
      }
      const index = fs.readFileSync(file);
      if (index.length % SLOT !== 0) {
        return log + ".index is not a whole number of entries";
      }
      const sizes = new Map<number, number>();
      for (let at = 0; at < index.length; at += SLOT) {
        const day = index.readUInt32LE(at + 8);
        if (day === 0) {
          continue;
        }
        const size = sizes.get(day) ?? Store.day_size(dir + "/" + log, day);
        sizes.set(day, size);
        if (!(index.readDoubleLE(at) + index.readUInt32LE(at + 12) <= size)) {
          return log + ".index points at no line of its log";
        }
      }
    }
    return null;
  }

  // the bytes of a log's file of a day; -1: no such day or file
  export function day_size(dir: string, day: number): number {
    const date = new Date(day * DAY);
    const file = Number.isNaN(date.getTime()) ? "" : dir + "/" + date.toISOString().slice(0, 10) + ".jsonl";
    return fs.existsSync(file) ? fs.statSync(file).size : -1;
  }

  // the server's chats there are to import: config.DIR/users/<id>
  export function chats(): string[] {
    const users = config.DIR + "/users";
    const ids = fs.existsSync(users) ? fs.readdirSync(users) : [];
    return ids.map((id) => users + "/" + id).filter((dir) => fs.existsSync(dir + "/main.index"));
  }

}

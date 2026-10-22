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
import * as path from "node:path";
import * as config from "./Config.ts";

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

// a chat's files an import copies (up/, posts' bodies, never: they are
// unlinked once open)
const FILES = ["main", "tree", "main.index", "tree.index", "view.json", "docs", "import.json"];

// the bytes read from a log's end to find its last message
const TAIL = 65536;

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
    const id = Store.id();
    const dir = Store.home(cwd) + "/" + id;
    fs.mkdirSync(dir, { recursive: true });
    const meta = { cwd, made: new Date().toISOString(), from, print: print || undefined };
    fs.writeFileSync(dir + "/meta.json", JSON.stringify(meta, null, 2) + "\n");
    return Store.read(dir)!;
  }

  // a session's dir read; null: none there
  export function read(dir: string): Session | null {
    try {
      const meta = JSON.parse(fs.readFileSync(dir + "/meta.json", "utf8"));
      const index = dir + "/main.index";
      const count = fs.existsSync(index) ? fs.statSync(index).size / 16 : 0;
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
  export function bring(src: string, cwd: string): Session {
    if (!fs.existsSync(src + "/main.index")) {
      throw new Error("no chat to import at " + src);
    }
    const session = Store.make(cwd, src);
    for (const name of FILES.filter((name) => fs.existsSync(src + "/" + name))) {
      fs.cpSync(src + "/" + name, session.dir + "/" + name, { recursive: true, preserveTimestamps: true });
    }
    return Store.read(session.dir)!;
  }

  // the server's chats there are to import: config.DIR/users/<id>
  export function chats(): string[] {
    const users = config.DIR + "/users";
    const ids = fs.existsSync(users) ? fs.readdirSync(users) : [];
    return ids.map((id) => users + "/" + id).filter((dir) => fs.existsSync(dir + "/main.index"));
  }

}

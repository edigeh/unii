// unii
// ====
// The terminal coding harness: one process holds the chat, its memory
// tree and the agent loop (Local.ts), and runs its tools here, in the
// working directory; no server, no port, no socket. Chats are kept by
// working directory (Store.ts), written as each message comes.
//
//   unii                 the latest session of this directory (a turn a
//                        crash cut goes on), or a new one; a new one too,
//                        saying why, if the latest won't open
//   unii --resume        the sessions of this directory to pick from; a
//                        turn a crash cut goes on when the picker closes
//                        on its session
//   unii --new           a new session
//   unii --import [dir]  the server's chat (default ~/.unii/users/1) as a
//                        new session: its history and memory tree; none
//                        is kept if it won't open
//   unii -p "message"    print mode: the reply on stdout, the rest on
//                        stderr; exits 1 if the turn didn't end well
//                        ("-" or none: the message read from stdin)

import * as fs from "node:fs";
import * as os from "node:os";
import type { End } from "./AskAI.ts";
import * as config from "./Config.ts";
import { Local, type Shown } from "./Local.ts";
import { Machine } from "./Machine.ts";
import { ERRORS, Store, type Session } from "./Store.ts";

// Constants
// =========

const USAGE = `unii: the terminal coding harness.
  unii                 go on with the latest session of this directory
  unii --resume        pick a session of this directory
  unii --new           start a new session
  unii --import [dir]  import the server's chat (default ${config.DIR}/users/1)
  unii -p "message"    print mode: the reply on stdout; "-" reads stdin
`;

// Main
// ====

export async function main(argv: string[]): Promise<number> {
  const cwd = fs.realpathSync(process.cwd());
  const [flag, arg] = argv;
  switch (flag) {
    case "-h":
    case "--help": {
      process.stdout.write(USAGE);
      return 0;
    }
    case "-p":
    case "--print": {
      return print(cwd, arg === undefined || arg === "-" ? await stdin() : argv.slice(1).join(" "));
    }
    case "--import": {
      const src = (arg ?? config.DIR + "/users/1").replace(/^~(?=\/|$)/, os.homedir());
      const s = Store.bring(src, cwd);
      process.stderr.write("unii: imported " + src + " as session " + s.id + " (" + s.count + " lines)\n");
      try {
        return await interactive(s);
      } catch (err) {
        // it didn't open: a crash after that goes through Tui.attach's handler
        Store.drop(s.dir);
        throw err;
      }
    }
    case "--new": {
      Store.sweep(cwd);
      return interactive(Store.make(cwd));
    }
    case "--resume":
    case "-r": {
      Store.sweep(cwd);
      return interactive(Store.latest(cwd) ?? Store.make(cwd), { chosen: true, resume: true });
    }
    case undefined: {
      Store.sweep(cwd);
      return interactive(Store.latest(cwd) ?? Store.make(cwd), { chosen: true });
    }
  }
  process.stderr.write("unii: no option " + flag + "\n" + USAGE);
  return 2;
}

async function interactive(session: Session, opts: { chosen?: boolean; resume?: boolean } = {}): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("unii: the chat needs a terminal; unii -p \"message\" runs one turn without\n");
    return 2;
  }
  const { Tui } = await import("./Tui.ts");
  return Tui.run(session, opts);
}

// Print
// =====

// one turn in a new session: unii's reply to stdout as it is logged, the
// rest (tool calls, notes) to stderr; 0 if it ended well
export async function print(cwd: string, text: string): Promise<number> {
  if (text.trim() === "") {
    process.stderr.write("unii: -p needs a message\n");
    return 2;
  }
  const session = Store.make(cwd, undefined, true);
  Store.lock(session.dir);
  const ends: End[] = [];
  let failed = false;
  const entry = (m: Shown) => {
    if (m.kind === "unii") {
      process.stdout.write(m.text + (m.more ? "" : "\n"));
    } else if (m.kind === "tool") {
      process.stderr.write("● " + m.text.split("\n")[0].slice(0, 200) + "\n");
    } else if (m.kind === "note") {
      failed ||= m.text.startsWith("No reply") || m.text.startsWith("Stopped");
      process.stderr.write("unii: " + m.text + "\n");
    }
  };
  const fault = (why: string) => {
    failed = true;
    process.stderr.write("unii: " + why + "\n");
  };
  const chat = Local.open(session.dir, cwd, { entry, live: () => {}, mind: () => {}, state: () => {}, ended: (end) => ends.push(end), fault });
  // a crash never reaches Local.close below: its tools die with it all the same
  process.on("exit", () => chat.closed || Machine.end());
  const stop = () => Local.interrupt(chat, "Stopped by a signal.");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  Local.say(chat, text);
  while (chat.busy) {
    await Bun.sleep(20);
  }
  await Local.close(chat);
  Store.unlock(session.dir);
  const ok = !failed && ends.length > 0 && ends[ends.length - 1].ok;
  return ok ? 0 : 1;
}

async function stdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }
  return await new Response(Bun.stdin.stream()).text();
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    const logged = Store.log_error(err);
    const plain = err instanceof Error && err.name === "Error";
    process.stderr.write("unii: " + String(err?.message ?? err) + (logged && !plain ? " (its stack is in " + ERRORS + ")" : "") + "\n");
    process.exit(1);
  });
}

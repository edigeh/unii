// unii
// ====
// The terminal coding harness: one process holds the chat, its memory
// tree and the agent loop (Local.ts), and runs its tools here, in the
// working directory; no server, no port, no socket. Chats are kept by
// working directory (Store.ts), written as each message comes.
//
//   unii                 the latest session of this directory (a turn a
//                        crash cut goes on), or a new one
//   unii --resume        the sessions of this directory to pick from
//   unii --new           a new session
//   unii --import [dir]  the server's chat (default ~/.unii/users/1) as a
//                        new session: its history and memory tree
//   unii -p "message"    print mode: the reply on stdout, the rest on
//                        stderr; exits 1 if the turn didn't end well
//                        ("-" or none: the message read from stdin)

import * as fs from "node:fs";
import * as os from "node:os";
import type { End } from "./AskAI.ts";
import * as config from "./Config.ts";
import { Local, type Shown } from "./Local.ts";
import { Store, type Session } from "./Store.ts";

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
      return interactive(s, false);
    }
    case "--new": {
      return interactive(Store.make(cwd), false);
    }
    case "--resume":
    case "-r": {
      return interactive(Store.latest(cwd) ?? Store.make(cwd), true);
    }
    case undefined: {
      return interactive(Store.latest(cwd) ?? Store.make(cwd), false);
    }
  }
  process.stderr.write("unii: no option " + flag + "\n" + USAGE);
  return 2;
}

async function interactive(session: Session, resume: boolean): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("unii: the chat needs a terminal; unii -p \"message\" runs one turn without\n");
    return 2;
  }
  const { Tui } = await import("./Tui.ts");
  return Tui.run(session, { resume });
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
  const chat = Local.open(session.dir, cwd, { entry, live: () => {}, mind: () => {}, state: () => {}, ended: (end) => ends.push(end) });
  const stop = () => Local.interrupt(chat, "Stopped by a signal.");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
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
    process.stderr.write("unii: " + String(err?.message ?? err) + "\n");
    process.exit(1);
  });
}

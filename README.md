unii
====

A coding agent for the terminal whose chat never ends. One process holds
the chat, its memory tree and the agent loop, and runs its tools in the
directory you start it in. There is no server, and it opens no port and
no socket.

unii comes from [UniiChat](https://github.com/VictorTaelin/UniiChat): the
same agent and the same memory, run locally in one process. Its terminal
interface follows the design of [oh-my-pi](https://github.com/can1357/oh-my-pi)'s
interactive mode.

How it works
------------

- **One chat, a memory tree.** Every message is summarized into one line,
  and neighboring lines are merged in pairs, again and again, into a
  binary tree. Each call sees a view of the whole chat, up to 128 KB:
  recent messages one line each, older ones covered by fewer, broader
  lines. The agent can open any line into the two it was made from, down
  to the original message, so it never needs a compaction that throws
  the past away.
- **Built in the background.** A cheaper model (the compactor) writes
  the summaries as messages arrive. The view changes only at its end, so
  each call reads most of its input from the vendor's prompt cache.
- **Local tools.** The agent runs a shell, reads, writes and edits files
  in the working directory, and can drive a Mac's screen. Edits show as
  diffs, and tool output folds.
- **Saved as it goes.** Sessions are kept per working directory under
  ~/.unii/sessions, written as each message arrives. A turn cut by a
  crash goes on when unii starts again.

The design is in the header comment of each file. Start with Local.ts
(the chat and its turns), Memory.ts (the tree and the view), AskAI.ts
(model calls and the cache) and Tui.ts (the terminal).

Install
-------

You need [Bun](https://bun.sh).

    git clone https://github.com/edigeh/unii && cd unii
    ln -s "$PWD/bin/unii" ~/.local/bin/unii

Sign in through one of:

- **omp**: unii reads the sign-ins of [oh-my-pi](https://github.com/can1357/oh-my-pi)
  from its database (~/.omp/agent/agent.db) and refreshes them there.
  `codex` runs on a ChatGPT plan (omp's `openai-codex` sign-in),
  `opencode-go` on OpenCode Go (omp's `opencode-go` key).
- **API keys**: `ANTHROPIC_API_KEY` (`claude-api`, the default) or
  `OPENAI_API_KEY` (`openai-api`).

Then choose what runs, in ~/.unii/config.json:

    {
      "vendors": "codex,opencode-go",
      "pick": "codex:gpt-6.1-sol:medium:slow",
      "compactor": "codex:gpt-6-luna:medium:slow"
    }

Use
---

    unii                 go on with the latest session of this directory
    unii --resume        pick a session of this directory
    unii --new           start a new session
    unii --import [dir]  import a UniiChat server's chat (default
                         ~/.unii/users/1): its history and memory tree, as
                         a new session; the source is only read
    unii -p "message"    one turn: the reply on stdout, tool calls and
                         errors on stderr, exit 1 if the turn failed
                         ("-" reads the message from stdin)

In the chat:

- Enter sends; Shift+Enter or Ctrl+J adds a line; Up and Down walk the
  history. A paste arrives whole, however long.
- A message typed during a turn is taken between tool calls.
- Esc stops the reply and kills the running tool's process group.
- Ctrl+O opens or folds tool output; Ctrl+L redraws; Ctrl+C clears the
  editor, and twice quits; Ctrl+D on an empty editor quits.
- `/` lists the commands, with completion: `/model`, `/effort`,
  `/resume`, `/new`, `/import`, `/goal`, `/halt`, `/open`, `/help`,
  `/quit`.

The status line shows the model, its effort, the context used, the cost
and the working directory. The terminal's settings are restored however
unii ends, `kill -9` included (bin/unii keeps them).

Config
------

`~/.unii/config.json` (optional; the dir is `$UNII_DIR`). Each key may
also be set as the variable `UNII_<KEY>`:

- `vendors`: what may run, comma-separated: `claude-api` (default),
  `openai-api`, `codex`, `opencode-go`.
- `models`: the models offered, by label (Pick.ts; default all).
- `pick`: what a session runs on until it picks another,
  `vendor:model:effort:speed` (default `claude-api:sonnet-5.5:medium:slow`).
- `compactor`: what writes the summaries (default
  `claude-api:haiku-5.5:high:slow`).
- `rules`: a file appended to every system prompt.
- `omp`: omp's database (default ~/.omp/agent/agent.db).
- `codex`: with more than one ChatGPT account signed in to omp, the
  email of the one to use (default: the best plan).

Tests
-----

    bun test --isolate

The tests run on a stubbed model (wire.stub.ts) and a stubbed terminal
(term.stub.ts): the agent loop, sessions and imports, keys, the editor,
the renderer, and the interactive mode. Harness.test.ts checks that the
import graph opens no port or socket.

License
-------

Apache License 2.0 (LICENSE). See NOTICE for what comes from UniiChat.

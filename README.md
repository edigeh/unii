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
  crash goes on when unii starts again, or, with `--resume`, when the
  picker closes on its session.

The design is in the header comment of each file. Start with Local.ts
(the chat and its turns), Memory.ts (the tree and the view), AskAI.ts
(model calls and the cache) and Tui.ts (the terminal).

Install
-------

You need [Bun](https://bun.sh).

    git clone https://github.com/edigeh/unii && cd unii
    ln -s "$PWD/bin/unii" ~/.local/bin/unii

Sign in through one of:

- **`/login`**: unii's own sign-ins, kept in ~/.unii/auth.json (0600) and
  refreshed there. `openai-codex` (ChatGPT Plus/Pro) makes the `codex`
  vendor, and `opencode-go` takes its API key. The browser opens the
  provider's page; the redirect URL ChatGPT's page ends on, or the key
  OpenCode's shows, is pasted back into the chat, so nothing listens — no
  port is opened, as anywhere else in unii — and it works over ssh. A
  sign-in made at omp first is not needed.
- **omp**: a vendor unii has no sign-in of its own for falls back to
  [oh-my-pi](https://github.com/can1357/oh-my-pi)'s database
  (~/.omp/agent/agent.db), and its tokens are refreshed there.
- **API keys**: `ANTHROPIC_API_KEY` (`claude-api`, the default) or
  `OPENAI_API_KEY` (`openai-api`).

Then choose what runs, in ~/.unii/config.json:

    {
      "vendors": "codex,opencode-go",
      "pick": "codex:gpt-6.1-sol:medium:slow",
      "compactor": "codex:gpt-6-luna:medium:slow"
    }

A sign-in made with `/login` adds its vendor to what is offered, now
and on later runs: Login.ts asks for it at startup, so a config `vendors`
without it does not keep it out.

Use
---

    unii                 go on with the latest session of this directory;
                         if it won't open, a new one says why and it stays
                         on disk
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
- `/` lists the commands, with completion: `/login`, `/model`,
  `/effort`, `/resume`, `/new`, `/import`, `/goal`, `/halt`, `/open`,
  `/help`, `/quit`.
- `/model` opens the model selector, after omp's: it takes the editor's
  place, its title with how many models and vendors it offers, a search
  field (type to filter by vendor or model), the models under the vendor
  that runs them in columns `Ctx` and `$/M` (list prices per M tokens,
  `included` when a plan runs it; `$/M` goes first on a narrow terminal),
  the model in use marked `✓`, and the marked one's facts (its id,
  context, prices, speeds) under a rule, with a warning when the chat is
  already over that model's context. Enter picks it, Esc closes; `/effort`
  picks the effort the same way.

Sign-in: `/login` lists ChatGPT/codex and OpenCode Go, the ones signed in
saying so; `/login openai-codex` (or any part of a provider's id or name)
starts one directly. The redirect URL or key is pasted into the editor and
Enter sends it; Esc cancels. What is kept is `~/.unii/auth.json`, one entry
per provider.

The status line shows the model, its effort, the context used, the cost
and the working directory. The terminal's settings are restored however
unii ends, `kill -9` included (bin/unii keeps them).

Config
------

`~/.unii/config.json` (optional; the dir is `$UNII_DIR`). Each key may
also be set as the variable `UNII_<KEY>`:

- `vendors`: what may run, comma-separated: `claude-api` (default),
  `openai-api`, `codex` (`/login openai-codex`), `opencode-go`
  (`/login opencode-go`).
- `models`: the models offered, by label (Pick.ts; default all).
- `pick`: what a session runs on until it picks another,
  `vendor:model:effort:speed` (default `claude-api:sonnet-5.5:medium:slow`).
- `compactor`: what writes the summaries (default
  `claude-api:haiku-5.5:high:slow`).
- `rules`: a file appended to every system prompt.
- `omp`: omp's database, read only for a vendor unii has no sign-in of its
  own for (default ~/.omp/agent/agent.db).
- `codex`: with more than one ChatGPT account signed in to omp, the
  email of the one to use (default: the best plan).

Tests
-----

    bun test --isolate

The tests run on a stubbed model (wire.stub.ts) and a stubbed terminal
(term.stub.ts): the agent loop, sessions and imports, keys, the editor,
the renderer, the interactive mode, and the sign-ins (Login.test.ts: the
authorization URLs, the code pasted back, the token kept, a refresh).
Harness.test.ts checks that the import graph opens no port or socket.

License
-------

Apache License 2.0 (LICENSE). See NOTICE for what comes from UniiChat.

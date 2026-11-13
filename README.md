unii
====

[![test](https://github.com/edigeh/unii/actions/workflows/test.yml/badge.svg)](https://github.com/edigeh/unii/actions/workflows/test.yml)

A coding agent for the terminal whose chat never ends. One process holds
the chat, its memory tree and the agent loop, and runs its tools in the
directory you start it in. There is no server, and it opens no port and
no socket.

unii comes from [UniiChat](https://github.com/VictorTaelin/UniiChat): the
same agent and the same memory, run locally in one process. Its terminal
interface follows the design of [oh-my-pi](https://github.com/can1357/oh-my-pi)'s
interactive mode.

- [How it works](#how-it-works)
- [Install](#install)
- [Sign in](#sign-in)
- [Configure](#configure)
- [Use](#use)
- [Project layout](#project-layout)
- [Development](#development)
- [License](#license)

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
  `~/.unii/sessions`, written as each message arrives. A turn cut by a
  crash goes on when unii starts again, or, with `--resume`, when the
  picker closes on its session.

Install
-------

You need [Bun](https://bun.sh) 1.4 or later.

    git clone https://github.com/edigeh/unii && cd unii
    ln -s "$PWD/bin/unii" ~/.local/bin/unii

unii has no runtime dependencies, so `bun install` is needed only for
development (it fetches the Bun type definitions).

Sign in
-------

unii signs in through one of:

- **`/login`**: unii's own sign-ins, kept in `~/.unii/auth.json` (0600)
  and refreshed there. `openai-codex` (ChatGPT Plus/Pro) makes the
  `codex` vendor, and `opencode-go` takes its API key. The browser opens
  the provider's page; the redirect URL ChatGPT's page ends on, or the
  key OpenCode's shows, is pasted back into the chat, so nothing listens
  (no port is opened, as anywhere else in unii) and it works over ssh.
- **omp**: a vendor unii has no sign-in of its own for falls back to
  [oh-my-pi](https://github.com/can1357/oh-my-pi)'s database
  (`~/.omp/agent/agent.db`), and its tokens are refreshed there.
- **API keys**: `ANTHROPIC_API_KEY` (`claude-api`, the default) or
  `OPENAI_API_KEY` (`openai-api`).

`/login` lists ChatGPT/codex and OpenCode Go, the ones signed in saying
so; `/login openai-codex` (or any part of a provider's id or name) starts
one directly. The redirect URL or key is pasted into the editor and Enter
sends it; Esc cancels. `~/.unii/auth.json` keeps one entry per provider.

A sign-in made with `/login` adds its vendor to what is offered, now and
on later runs: `src/Login.ts` asks for it at startup, so a config
`vendors` without it does not keep it out.

Configure
---------

`~/.unii/config.json` is optional; its directory is `$UNII_DIR`. Each key
may also be set as the variable `UNII_<KEY>`.

    {
      "vendors": "codex,opencode-go",
      "pick": "codex:gpt-6.1-sol:medium:slow",
      "compactor": "codex:gpt-6-luna:medium:slow"
    }

| Key         | What it sets | Default |
| ----------- | ------------ | ------- |
| `vendors`   | What may run, comma-separated: `claude-api`, `openai-api`, `codex` (`/login openai-codex`), `opencode-go` (`/login opencode-go`) | `claude-api` |
| `models`    | The models offered, by label (`src/Pick.ts`) | all |
| `pick`      | What a session runs on until it picks another, `vendor:model:effort:speed` | `claude-api:sonnet-5.5:medium:slow` |
| `compactor` | What writes the summaries | `claude-api:haiku-5.5:high:slow` |
| `rules`     | A file appended to every system prompt | none |
| `omp`       | omp's database, read only for a vendor unii has no sign-in of its own for | `~/.omp/agent/agent.db` |
| `codex`     | With more than one ChatGPT account signed in to omp, the email of the one to use | the best plan |

Use
---

### Command line

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

### In the chat

- Enter sends; Shift+Enter or Ctrl+J adds a line; Up and Down walk the
  history. A paste arrives whole, however long.
- A message typed during a turn is taken between tool calls.
- Esc stops the reply and kills the running tool's process group.
- Ctrl+O opens or folds tool output; Ctrl+L redraws; Ctrl+C clears the
  editor, and twice quits; Ctrl+D on an empty editor quits.
- `/` lists the commands, with completion: `/login`, `/model`,
  `/effort`, `/resume`, `/new`, `/import`, `/goal`, `/halt`, `/open`,
  `/help`, `/quit`.

`/model` opens the model selector, after omp's. It takes the editor's
place, with:

- a title saying how many models and vendors it offers;
- a search field (type to filter by vendor or model);
- the models under the vendor that runs them, in columns `Ctx` and `$/M`
  (list prices per M tokens, `included` when a plan runs it; `$/M` goes
  first on a narrow terminal), the model in use marked `✓`;
- the marked model's facts (its id, context, prices, speeds) under a
  rule, with a warning when the chat is already over that model's
  context.

Enter picks it, Esc closes. `/effort` picks the effort the same way.

The status line shows the model, its effort, the context used, the cost
and the working directory. The terminal's settings are restored however
unii ends, `kill -9` included (`bin/unii` keeps them).

Project layout
--------------

    bin/unii        launcher: runs src/unii.ts and restores the terminal
    src/            the harness, one module per file
      *.test.ts     tests, next to the module they cover
      *.stub.ts     test stubs: the model wire, the terminal, the scratch dir
      prompt.txt    the system prompt
      Computer.swift  the Mac screen driver, run by Computer.ts

The design is in the header comment of each file. Start with
`src/Local.ts` (the chat and its turns), `src/Memory.ts` (the tree and
the view), `src/AskAI.ts` (model calls and the cache) and `src/Tui.ts`
(the terminal). `src/unii.ts` is the entry point.

Development
-----------

    bun install          # Bun type definitions and TypeScript
    bun run typecheck    # tsc -p ., strict, over src/
    bun run test         # bun test --isolate

The tests run on a stubbed model (`src/wire.stub.ts`) and a stubbed
terminal (`src/term.stub.ts`): the agent loop, sessions and imports,
keys, the editor, the renderer, the interactive mode, and the sign-ins
(`src/Login.test.ts`: the authorization URLs, the code pasted back, the
token kept, a refresh). `src/Harness.test.ts` checks that the import
graph opens no port or socket. `bunfig.toml` preloads
`src/scratch.stub.ts`, so every test runs in one scratch directory and
never reaches `~/.unii`.

`src/Store.test.ts` imports a copy of a real UniiChat chat when one is
at `work/data-copy/users/1` (ignored by git), and a chat it makes itself
otherwise.

CI runs the suite on macOS for every pull request and every push to
`main` (`.github/workflows/test.yml`).

License
-------

Apache License 2.0 ([LICENSE](LICENSE)). See [NOTICE](NOTICE) for what
comes from UniiChat.

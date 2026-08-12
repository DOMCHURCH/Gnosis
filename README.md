# dom

A terminal coding agent. OpenRouter is the only provider, with runtime model switching. Windows-first, POSIX-compatible.

```
██████╗   ██████╗  ███╗   ███╗
██╔══██╗ ██╔═══██╗ ████╗ ████║
██║  ██║ ██║   ██║ ██╔████╔██║
██║  ██║ ██║   ██║ ██║╚██╔╝██║
██████╔╝ ╚██████╔╝ ██║ ╚═╝ ██║
╚═════╝   ╚═════╝  ╚═╝     ╚═╝
```

## Install

```sh
npm install
npm run build
npm link      # puts `dom` on your PATH
```

Set your key (either works):

```sh
export OPENROUTER_API_KEY=sk-or-...      # env wins
# or add { "apiKey": "sk-or-..." } to ~/.dom/config.json
```

## Use

```sh
dom                       # start the TUI
dom -c                    # resume the latest session for this directory
dom -r <id>               # resume a specific session
dom --model <id>          # start on a specific model
dom --yolo                # allow all tools (dangerous commands still prompt)
dom --headless "message"  # one-shot, no TUI
```

### In-session commands

`/model [id]` · `/mode <ask|plan|yolo>` · `/clear` · `/compact` · `/tools` · `/cost` · `/resume` · `/help` · `/exit`

`@` opens a file picker that inserts a path. `!<command>` runs a shell command directly (still gated). `Ctrl+C` aborts the in-flight request and returns to the prompt.

### Permission modes

- **ask** (default) — read/glob/grep run free; write/edit/bash prompt with a preview (a colored diff for edits, the exact command for bash). Approve once with *always* to whitelist it for the session.
- **plan** — every mutating tool is refused.
- **yolo** — everything runs without prompting, except commands matching `rm -rf`, `git push --force`, `dd`, `mkfs`, `curl | sh`, `> /dev/…`, which always prompt.

## Tools

`read` · `write` · `edit` · `bash` · `glob` · `grep` — zod schemas are the source of truth; JSON Schema (for the API) and TS types are both derived from them.

## Storage

- `~/.dom/config.json` — model, mode, apiKey
- `~/.dom/models.json` — model catalog cache (24h TTL)
- `~/.dom/sessions/<id>.json` — history, cwd, cumulative cost (written after every turn)
- `AGENTS.md` in the working directory, if present, is appended to the system prompt.

## Build order

`provider → tools → loop → headless CLI → permission gate → Ink UI → banner → sessions`. The loop is runnable without the TUI (`dom --headless`) so it can be verified independently.

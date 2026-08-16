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
dom --no-auto-commit      # don't commit each successful write/edit to git
dom --headless "message"  # one-shot, no TUI
```

### In-session commands

`/model [id]` · `/mode <ask|plan|yolo>` · `/approve` · `/revise <text>` · `/new` · `/tabs` · `/tab <n|name>` · `/alltabs` · `/close` · `/jobs` · `/job <id>` · `/kill <id>` · `/hooks` · `/init [--force]` · `/clear` · `/compact` · `/tools` · `/cost` · `/verbose` · `/undo` · `/resume` · `/help` · `/exit`

Tool calls render compactly — one line per call as a signature (`● Read(src/engine.ts)`, `● Bash(npm run build)`, `● Http(GET api.example.com/x)`) with a one-line summarized result beneath (`Read 59 lines`, `Added 4 lines, removed 2 lines`, `200 OK · 4.2KB json`). Failures always show the full error. `/verbose` restores full, unsummarized output for the session.

dom boots straight onto your configured default (`config.model`) — no startup picker. `/model` and `/mode` are **session-scoped**: they change the current session only, never `config.json`. The status bar shows a dim `*` next to the model whenever the session model differs from the saved default. To change the default, use `/model --save [<id>]` (or press `ctrl+s` in the `/model` picker) and `/mode <ask|plan|yolo> --save`. `-m/--model` at launch is likewise session-only.

**Tabs** — each tab is its own engine (own history, model, cwd, permission mode). `/new [name] [purpose]` opens one, `/tabs` lists them, `/tab <n|name>` switches, `/close` closes the active tab. Switching is a full-screen replace: the screen clears and only the target tab's transcript is drawn, so each tab reads as its own session. `/alltabs` opens a read-only tiled overview of every tab (2 across for 2–4 tabs, 3 for 5+; a stacked list below 100 columns) — cells update live as background tabs produce output, and the active tab's cell border is highlighted; `/alltabs` again (or any `/tab` switch) exits back to single view. `Ctrl+1..9` is a best-effort switch alias for `/tab` (some terminals don't emit those chords, so `/tab` is the reliable path). Only the active tab renders; background tabs keep running and badge the tab bar when they produce output (`•`) or need approval (amber `●`) — an approval never steals focus, it waits until you switch over. A tab's model can hand work to another tab with the `send_message` / `list_tabs` tools (loop-guarded: max 3 hops, no immediate reply to the sender, 20 messages/session).

`@` opens a file picker that inserts a path. `!<command>` runs a shell command directly (still gated). `Ctrl+C` aborts the in-flight request and returns to the prompt.

### Permission modes

- **ask** (default) — read/glob/grep run free; write/edit/bash prompt with a preview (a colored diff for edits, the exact command for bash). Approve once with *always* to whitelist it for the session.
- **plan** — write, edit, and bash are removed from the tool list entirely (only `read`/`glob`/`grep`/`http` remain), so the model researches and produces a written plan instead of acting. `/approve` switches to ask mode and executes the plan (feeding it back as context); `/revise <text>` amends the plan without executing. `shift+tab` still cycles modes.
- **yolo** — everything runs without prompting, except commands matching `rm -rf`, `git push --force`, `dd`, `mkfs`, `curl | sh`, `> /dev/…`, and mutating HTTP methods (`POST`/`PUT`/`PATCH`/`DELETE`), which always prompt.

**Read before edit.** dom won't edit or overwrite a file it hasn't read this session — it returns "read it first". If a file changed on disk since it was read, the edit is refused until it's re-read, so the model never edits stale content. Creating a brand-new file is exempt.

**Auto-commit.** Every successful write or edit is committed on its own to the current git repo with a `dom: <verb> <file>` message — only that one file (never `git add -A`), and a silent no-op outside a repo (it never runs `git init`). `/undo` reverts dom's most recent commit and reports what it undid. Turn it off with `"autoCommit": false` in config or `--no-auto-commit`.

## Background jobs

Pass `run_in_background: true` to `bash` — for dev servers, watchers, or long builds — and the call returns immediately with a job id while the command keeps running, so the model can carry on. `/jobs` lists running jobs, `/job <id>` shows its output so far, and `/kill <id>` terminates the whole process tree. A finishing job appends a dim line to the transcript. Background jobs die with the session.

## Hooks

Executable lifecycle scripts in `~/.dom/hooks/` (global) and `./.dom/hooks/` (project — shadows global per event), each named after its event: `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`. Each hook receives the event as JSON on stdin (the extension picks the interpreter: `.mjs`/`.js` → node, `.py` → python, `.ps1` → powershell, `.sh`/none → shell). `PreToolUse` is the only **blocking** hook: a clean non-zero exit blocks the tool call and the script's stderr is returned to the model as the tool error. Every other event is fire-and-forget. All hooks have a 5s timeout — a timeout or crash logs a dim warning and never blocks. `/hooks` lists what's registered.

## /init

`/init` scans the repo and writes an `AGENTS.md`: the detected language and framework, the build/test/lint commands (from `package.json` or the equivalent), a one-line-per-top-level-directory layout, and observed conventions (module style, test framework, formatter). It's prose, under 60 lines, and refuses to overwrite an existing `AGENTS.md` without `--force`. `AGENTS.md` is appended to the system prompt each session.

## Model fallback

Set `"fallbackModel"` in `~/.dom/config.json` to survive a dead primary. When the active model returns a **404**, or an **upstream/shared-pool 429** (`limit_source: upstream_provider_shared_pool` — common on `:free` models, and not clearable by retrying our own request), dom switches to the fallback for the rest of the session, re-runs the turn on it, and prints a dim notice naming both models. An ordinary 429 from *your own* rate limit still retries in place with exponential backoff.

## Prompt caching

For models whose provider supports explicit cache breakpoints (Anthropic, Gemini — detected from the catalog's cache-write price), dom sends `cache_control` breakpoints that OpenRouter forwards to the provider: after the tool definitions, after the system prompt (skill descriptions included), and on the last message (moved forward each turn as history grows). Within a multi-step turn, iterations after the first read the cached prefix. Models without cache-breakpoint support (OpenAI's automatic caching, DeepSeek, Groq) receive **no** `cache_control` at all. `/cost` shows cached vs uncached input tokens so the saving is visible.

## Tools

`read` · `write` · `edit` · `bash` · `glob` · `grep` · `http` — zod schemas are the source of truth; JSON Schema (for the API) and TS types are both derived from them. In multi-tab sessions the model additionally gets `send_message` / `list_tabs`.

### `http`

Make an outbound HTTP(S) request: `{ url, method?, headers?, body?, timeout? }` (default `GET`, 30s timeout). Returns the status, response headers, and body (JSON pretty-printed), truncated at 2000 lines / 50KB like the other tools; follows up to 5 redirects.

- **Permission** — `GET`/`HEAD` may auto-approve in yolo; `POST`/`PUT`/`PATCH`/`DELETE` always prompt with the full URL, in every mode.
- **SSRF guard** (hard block, never prompted) — `localhost`, `127.0.0.1`, `0.0.0.0`, `::1`, the private ranges (`10.x`, `192.168.x`, `172.16–31.x`), the cloud-metadata address `169.254.169.254`, and any non-`http(s)` scheme (`file://`, `ftp://`, …). Redirect targets are re-checked on every hop.
- **Secrets** — reference a key by name as `${VAR_NAME}` in the url, a header value, or the body. The value is read from `~/.dom/.env` (`NAME=value` lines, `#` comments, optional quotes) at request time and substituted in. Keys never enter message history, session files, or the transcript: the echoed request shows the `${VAR}` verbatim, and `Authorization` / `api-key`-style headers render as `<redacted>`. A missing key errors with the variable name and the file to add it to.

The **public-apis skill** (`~/.dom/skills/public-apis/`) caches the [public-apis](https://github.com/public-apis/public-apis) index to `~/.dom/cache/public-apis.md` (refreshed at most every 30 days), greps it by category, reports the Auth column honestly (many "free" entries still need a key), HEAD-checks links before recommending them, then calls `http`.

## Storage

- `~/.dom/config.json` — model, fallbackModel, mode, apiKey, autoCommit
- `~/.dom/.env` — `NAME=value` secrets, substituted into `http` requests as `${NAME}` (never logged)
- `~/.dom/models.json` — model catalog cache (24h TTL)
- `~/.dom/sessions/<id>.json` — history, cwd, cumulative cost (written after every turn)
- `~/.dom/cache/` — code-maintained skill data (e.g. the public-apis index)
- `~/.dom/skills/<name>/SKILL.md` — skills advertised in the system prompt (also `./.dom/skills/`)
- `~/.dom/hooks/<event>` — lifecycle hook scripts (also `./.dom/hooks/`, which shadows global)

All of `~/.dom` is off-limits to the tools **except** `cache/` and `skills/`, which any tool (including `bash`) may read and write — that's where skill data lives. `config.json`, `.env`, and `sessions/` are always blocked, even from a read.
- `AGENTS.md` in the working directory, if present, is appended to the system prompt.

## Build order

`provider → tools → loop → headless CLI → permission gate → Ink UI → banner → sessions`. The loop is runnable without the TUI (`dom --headless`) so it can be verified independently.

## Verify

`npm run build && npm run verify` runs the offline regression suite in `verify/`: model resolution + `:batch` filtering, 429 backoff, 413 (too-large) handling, the rejection-loop guard, the `http` gate + secret substitution/redaction, the `~/.dom` bash carve-out (cache/skills allowed, config/.env/sessions blocked), the multi-tab controller (loop guards + badging), the `/alltabs` split-view layout, a real `Banner` render (compact, no model line), and a headless Ink mount of the TUI driving `/new`, `/tabs`, `/tab`, and `/alltabs`. Each suite runs in its own process, mocks the network, and isolates `$USERPROFILE` — nothing touches your real `~/.dom`.

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
dom -p "prompt"           # pipe mode: one turn, final answer to stdout, exit
dom --json "prompt"       # headless: one turn, structured JSONL events to stdout
```

### In-session commands

`/model [id]` · `/mode <ask|plan|yolo>` · `/approve` · `/revise <text>` · `/new` · `/tabs` · `/tab <n|name>` · `/alltabs` · `/close` · `/worktree <name>` · `/workspace <add|list|remove>` · `/memory` · `/jobs` · `/job <id>` · `/kill <id>` · `/hooks` · `/init [--force]` · `/map` · `/clear` · `/compact` · `/tools` · `/cost` · `/context` · `/trace` · `/verbose` · `/undo` · `/resume` · `/help` · `/exit`

`/resume` with no argument opens a picker of prior sessions **for the current directory** (newest first, with message count, model, and age). `/context` shows what's filling the context window broken down by category — system prompt, summary, user messages, assistant text, tool calls, tool results, images — each with a token count and its share of used tokens and of the window.

Tool calls render compactly — one line per call as a signature (`● Read(src/engine.ts)`, `● Bash(npm run build)`, `● Http(GET api.example.com/x)`) with a one-line summarized result beneath (`Read 59 lines`, `Added 4 lines, removed 2 lines`, `200 OK · 4.2KB json`). Failures always show the full error. `/verbose` restores full, unsummarized output for the session.

dom boots straight onto your configured default (`config.model`) — no startup picker. `/model` and `/mode` are **session-scoped**: they change the current session only, never `config.json`. The status bar shows a dim `*` next to the model whenever the session model differs from the saved default. To change the default, use `/model --save [<id>]` (or press `ctrl+s` in the `/model` picker) and `/mode <ask|plan|yolo> --save`. `-m/--model` at launch is likewise session-only.

**Tabs** — each tab is its own engine (own history, model, cwd, permission mode). `/new [name] [purpose]` opens one, `/tabs` lists them, `/tab <n|name>` switches, `/close` closes the active tab. Switching is a full-screen replace: the screen clears and only the target tab's transcript is drawn, so each tab reads as its own session. `/alltabs` opens a read-only tiled overview of every tab (2 across for 2–4 tabs, 3 for 5+; a stacked list below 100 columns) — cells update live as background tabs produce output, and the active tab's cell border is highlighted; `/alltabs` again (or any `/tab` switch) exits back to single view. `Ctrl+1..9` is a best-effort switch alias for `/tab` (some terminals don't emit those chords, so `/tab` is the reliable path). Only the active tab renders; background tabs keep running and badge the tab bar when they produce output (`•`) or need approval (amber `●`) — an approval never steals focus, it waits until you switch over. A tab's model can hand work to another tab with the `send_message` / `list_tabs` tools (loop-guarded: max 3 hops, no immediate reply to the sender, 20 messages/session).

`@` opens a fuzzy file picker that inserts a path — matches are subsequence-scored (contiguous runs and path-segment boundaries favored) and ranked by the repo map, so the most central files surface first and typing a few characters of a name jumps to it. `!<command>` runs a shell command directly (still gated). `Ctrl+C` aborts the in-flight request and returns to the prompt. `Ctrl+R` reverse-searches your prompt history — prior prompts from this session (newest first) then from earlier sessions for the same directory, de-duplicated — as a filterable picker; select one to drop it back into the input.

### Permission modes

- **ask** (default) — read/glob/grep run free; write/edit/bash prompt with a preview (a colored diff for edits, the exact command for bash). Approve once with *always* to whitelist it for the session.
- **plan** — write, edit, and bash are removed from the tool list entirely (only `read`/`glob`/`grep`/`http` remain), so the model researches and produces a written plan instead of acting. `/approve` switches to ask mode and executes the plan (feeding it back as context); `/revise <text>` amends the plan without executing. `shift+tab` still cycles modes.
- **yolo** — everything runs without prompting, except commands matching `rm -rf`, `git push --force`, `dd`, `mkfs`, `curl | sh`, `> /dev/…`, and mutating HTTP methods (`POST`/`PUT`/`PATCH`/`DELETE`), which always prompt.

**Read before edit.** dom won't edit or overwrite a file it hasn't read this session — it returns "read it first". If a file changed on disk since it was read, the edit is refused until it's re-read, so the model never edits stale content. Creating a brand-new file is exempt.

**Auto-commit.** Every successful write or edit is committed on its own to the current git repo with a `dom: <verb> <file>` message — only that one file (never `git add -A`), and a silent no-op outside a repo (it never runs `git init`). `/undo` reverts dom's most recent commit and reports what it undid. Turn it off with `"autoCommit": false` in config or `--no-auto-commit`.

## Memory bank

dom keeps a durable, per-project **memory bank** the model writes to with the `memory` tool (`add` a note, `list` it, `clear` it) and that is **re-injected into the system prompt at the start of every session** — so a convention, gotcha, or decision it learns once is remembered next time. Each project has its own bank, keyed by the project's absolute path and stored **outside the repo** under `~/.dom/memory/` (it never pollutes your tree). `/memory` shows the bank (with its file path); `/memory add <note>` adds one by hand and `/memory clear` erases it. Notes are deduped and stored as bullets. (`/mem` is an alias.)

## Multi-root workspaces

A session can span more than one project root. `/workspace add <path>` registers an extra root (or set `"workspaceRoots": ["../other"]` in config); `/workspace list` shows them and `/workspace remove <path>` drops one (the primary root — your cwd — always stays). With 2+ roots, **`grep` and `glob` called without an explicit `path` search every root** and prefix each hit with the root's name (`api/src/db.ts:12:…`, `web/src/db.ts:8:…`), so you can search across repos in one call; pass an explicit `path` to scope back to one. The roots are advertised in the system prompt so the model knows they exist. (`/ws` is an alias.)

## Git worktree isolation

`/worktree <name>` runs work in a **separate git worktree** on its own branch (`dom/<name>`), checked out under `~/.dom/worktrees/` and opened as a new tab. Edits and auto-commits there never touch your current working tree or branch — you keep working in the main tab while the worktree tab explores in parallel. When the work is good, `/worktree merge <name>` merges the branch back (`--no-ff`, so the isolation stays visible in history); if it isn't, `/worktree remove <name>` discards the worktree and its branch without a trace on your branch. `/worktree list` shows the open ones. The name is slugged (`Feature X` → `feature-x`); creating a name whose branch already exists is refused. Merge conflicts abort cleanly and report, leaving your tree untouched. (`/wt` is an alias.)

## Headless & JSON output

Two non-interactive one-shot modes read piped stdin (appended to the prompt, so `git diff | dom -p "review this"` works) and never open the TUI:

- **`dom -p "prompt"`** (pipe mode) writes only the model's final answer to **stdout**; progress and errors go to stderr, so it composes in shell pipelines. `--save` persists the turn as a session (off by default). Exit code is non-zero on error or an empty answer.
- **`dom --json "prompt"`** streams a structured event log to stdout as **newline-delimited JSON** — one complete object per line, so a web UI or script can spawn dom and read events incrementally. This is the intended programmatic contract. Event types, in order: `session` (once, first — `sessionId`, `model`, `cwd`), then per activity `assistant` (text), `tool_use` (`id`, `name`, `input`), `tool_result` (`id`, `name`, `ok`, `output`), `system`, `permission` (a prompt auto-denied in headless — the `preview` is recorded so you can re-run with `--yolo`), `cost` (per turn), and finally `result` (once, last — `ok`, `text`, `usd`, `sessionId`, `capped`). The resumed-session notice and skill warnings go to **stderr** so stdout stays pure JSONL. `--json` takes precedence if combined with `-p`.

Secrets are redacted in `tool_use` inputs, `permission` previews, and assistant/result text before they reach stdout (tool outputs are already redacted upstream); the real values were used during execution — redaction is display-only. Both modes refuse anything that needs confirmation (bash/http prompts); read-only work and file edits proceed as in `--headless`.

## Budget ceiling

Each session has a dollar ceiling (`maxSessionUsd`, default $2). On reaching it dom halts the turn and prompts: decline to stop, approve to grant another allotment, or *always* to lift the ceiling for the rest of the session. While over budget, new `task` sub-agent and `oracle` spawns are refused. `/budget` shows spent vs. ceiling; `/budget <usd>` sets it. Headless/pipe runs halt at the ceiling rather than prompting.

## Command-hiding defense

Before a bash command is shown for approval, dom reveals anything that could hide part of it from you: tabs, zero-width/invisible/bidi-override Unicode, and other control characters are rendered as `<U+XXXX>` (tabs as `⇥`), and multi-line/chained commands are shown in full — never truncated to a benign-looking first line. A command containing hidden characters is flagged and **always prompts, even in yolo**. Only the display is normalized; the real command executes unchanged.

## Secret redaction

Tool output and the model's own tool-call args are scanned for credential patterns — OpenAI/OpenRouter/Anthropic-style `sk-…` keys, AWS `AKIA…`, GitHub `ghp_`/`github_pat_`, Slack `xox…`, Google `AIza…`, JWTs, `Bearer` tokens, and `PRIVATE KEY` blocks — and each is replaced with `<redacted:TYPE>` before it reaches the model, the transcript, or the session file. Redaction touches only the stored/displayed copy: the real command still executes with the real value, so a `cat .env` gets masked in history while the file on disk is untouched. Patterns are specific to avoid mangling ordinary output.

## Verifier subagent

`/verify` spawns a read-only subagent that judges whether the last turn's change actually accomplished the request. It receives **only** the original request and the `git diff` of the files edited that turn (committed + working-tree, since the pre-turn HEAD) — never the generator's system prompt or reasoning — and has **no tools**, so it can't be swayed by anything outside the diff. It replies `PASS`/`FAIL` on the first line plus specifics. `"autoVerify": true` runs it automatically after any turn that touched 2+ files. Its cost folds into the session.

## Auto lint/test loop

With `"autoFix": true` in config, after any turn that edited files dom runs the configured `lintCommand` then `testCommand` in the working directory. A non-zero exit is fed back to the model as a fix request (with the failure output) and it retries — up to 3 attempts, then it stops and reports "still failing". The commands are user-configured (trusted) so they run without a prompt; off by default, and a no-op if neither command is set.

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

## Repo map

At startup dom builds a tree-sitter-parsed, PageRank-ranked summary of the codebase's most-referenced **exported** symbols and injects it into the system prompt, so the model starts oriented instead of blind-searching. Grammars load as WebAssembly (`web-tree-sitter` + prebuilt `tree-sitter-wasms` — no native build); a language with no grammar is skipped rather than failing. Parses are cached in `~/.dom/cache/repomap.db` keyed by path + mtime, so a second run only reparses the files that changed. The serialization budget is `mapTokens` (default 1024). `/map` prints the current map and its token count.

## Tools

`read` · `write` · `edit` · `bash` · `glob` · `grep` · `http` · `task` — zod schemas are the source of truth; JSON Schema (for the API) and TS types are both derived from them. In multi-tab sessions the model additionally gets `send_message` / `list_tabs`.

### `http`

Make an outbound HTTP(S) request: `{ url, method?, headers?, body?, timeout? }` (default `GET`, 30s timeout). Returns the status, response headers, and body (JSON pretty-printed), truncated at 2000 lines / 50KB like the other tools; follows up to 5 redirects.

- **Permission** — `GET`/`HEAD` may auto-approve in yolo; `POST`/`PUT`/`PATCH`/`DELETE` always prompt with the full URL, in every mode.
- **SSRF guard** (hard block, never prompted) — `localhost`, `127.0.0.1`, `0.0.0.0`, `::1`, the private ranges (`10.x`, `192.168.x`, `172.16–31.x`), the cloud-metadata address `169.254.169.254`, and any non-`http(s)` scheme (`file://`, `ftp://`, …). Redirect targets are re-checked on every hop.
- **Secrets** — reference a key by name as `${VAR_NAME}` in the url, a header value, or the body. The value is read from `~/.dom/.env` (`NAME=value` lines, `#` comments, optional quotes) at request time and substituted in. Keys never enter message history, session files, or the transcript: the echoed request shows the `${VAR}` verbatim, and `Authorization` / `api-key`-style headers render as `<redacted>`. A missing key errors with the variable name and the file to add it to.

### `task` (sub-agents)

`task(description, prompt)` delegates an open-ended search or investigation to a fresh read-only sub-agent — "find where X is handled", "which files touch Y". The sub-agent has its own history and context budget (it inherits your cwd, model, and repo map) but only `read`/`glob`/`grep`/`http` — no writing, no shell, and no recursion — and is capped at 15 iterations / 50k tokens (on exceed it returns what it has with a truncation note). It runs to completion and returns only its final summary; its intermediate turns never enter your history. The transcript shows one line: `● Task(description)` then `⎿ N tools · N tokens` and the summary. Its cost is folded into the session and shown separately in `/cost`. Prefer it over grepping large output into your own context.

### `oracle`

`oracle(question)` consults a stronger model (config `oracleModel`, falling back to the session model when unset) on a hard, self-contained sub-problem. It runs a **single** completion with **no tools** and an **isolated context** — only the question, none of your files or history — so the model must put all needed context in the question, and it returns just the answer. Its tokens fold into the session cost and its dollar spend is tracked separately in `/cost` (`incl. $… oracle`). Excluded from plan mode and sub-agents. Use it sparingly for genuinely hard problems.

The **public-apis skill** (`~/.dom/skills/public-apis/`) caches the [public-apis](https://github.com/public-apis/public-apis) index to `~/.dom/cache/public-apis.md` (refreshed at most every 30 days), greps it by category, reports the Auth column honestly (many "free" entries still need a key), HEAD-checks links before recommending them, then calls `http`.

## Storage

- `~/.dom/config.json` — model, fallbackModel, mode, apiKey, autoCommit, mapTokens
- `~/.dom/.env` — `NAME=value` secrets, substituted into `http` requests as `${NAME}` (never logged)
- `~/.dom/models.json` — model catalog cache (24h TTL)
- `~/.dom/sessions/<id>.json` — history, cwd, cumulative cost (written after every turn)
- `~/.dom/cache/` — code-maintained caches: the public-apis index and the repo-map parse DB
- `~/.dom/skills/<name>/SKILL.md` — skills advertised in the system prompt (also `./.dom/skills/`)
- `~/.dom/hooks/<event>` — lifecycle hook scripts (also `./.dom/hooks/`, which shadows global)

All of `~/.dom` is off-limits to the tools **except** `cache/` and `skills/`, which any tool (including `bash`) may read and write — that's where skill data lives. `config.json`, `.env`, and `sessions/` are always blocked, even from a read.
- `AGENTS.md` in the working directory, if present, is appended to the system prompt.

## Build order

`provider → tools → loop → headless CLI → permission gate → Ink UI → banner → sessions`. The loop is runnable without the TUI (`dom --headless`) so it can be verified independently.

## Notifications

When a turn finishes or a tool needs approval, dom sends a desktop notification (config `notify`, default on; set `"notify": false` to disable). It uses `osascript` on macOS and `notify-send` on Linux **only for local sessions** — over SSH those would pop on the remote host, so dom instead emits an OSC 9 terminal escape plus a bell that the *local* terminal renders. The terminal escape is also the Windows / no-native-tool fallback, and a failed native notifier falls back to it too. A ctrl+c abort is your own action, so it doesn't notify.

## Tracing

Every model call, tool call, and user turn is appended as one structured JSONL line to `~/.dom/traces/<session>.jsonl` — model id and per-call tokens/cost for model calls, tool name + (truncated) args + error flag + output size for tool calls. `/trace` prints a summary of the current session: event/turn/call counts, in/out (and cached) tokens, cost, a per-tool breakdown, per-model breakdown, and the file path. Tracing is best-effort (never breaks a turn) and skipped for ephemeral sessions (sub-agents, eval, `-p` without `--save`).

## Eval

`npm run build && npm run eval` runs a fixed regression suite of 10 tasks — each set up in its own scratch repo with a deterministic, outcome-based check (final file state or the model's answer, never a specific tool sequence) — against the live model, and scores pass/fail plus tokens and cost per task. The first run records a baseline (`eval/baseline.json`); later runs print the delta vs baseline (score, tokens, cost, and any tasks that **regressed** or got fixed) so you can see whether a change actually helped. `-- --record` re-records the baseline; `DOM_EVAL_MODEL=<id>` overrides the model. Real runs need an API key and make (cheap-model) calls. The harness machinery — scoring, baseline record/compare, regression detection — is itself covered offline by `verify/s7-eval.mjs`, which drives it with a deterministic mock and asserts a sabotaged system prompt drops the score.

## Verify

`npm run build && npm run verify` runs the offline regression suite in `verify/`: model resolution + `:batch` filtering, 429 backoff, 413 (too-large) handling, the rejection-loop guard, the `http` gate + secret substitution/redaction, the `~/.dom` bash carve-out (cache/skills allowed, config/.env/sessions blocked), the multi-tab controller (loop guards + badging), the `/alltabs` split-view layout, a compact `Banner` render (no model line), and a headless Ink mount driving `/new`, `/tabs`, `/tab`, and `/alltabs` — plus auto-commit + `/undo`, read-before-edit, background jobs, plan-mode teeth, hooks, `/init`, sub-agents (`task`), and the tree-sitter repo map. Each suite runs in its own process, mocks the network, and isolates `$USERPROFILE` — nothing touches your real `~/.dom`.

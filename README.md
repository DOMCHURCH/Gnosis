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

**Tabs** — each tab is its own engine (own history, model, cwd, permission mode). `/new [name] [purpose]` opens one, `/tabs` lists them, `/tab <n|name>` switches, `/close` closes the active tab. `Ctrl+1..9` is a best-effort switch alias for `/tab` (some terminals don't emit those chords, so `/tab` is the reliable path). Only the active tab renders; background tabs keep running and badge the tab bar when they produce output (`•`) or need approval (amber `●`) — an approval never steals focus, it waits until you switch over. A tab's model can hand work to another tab with the `send_message` / `list_tabs` tools (loop-guarded: max 3 hops, no immediate reply to the sender, 20 messages/session).

`@` opens a file picker that inserts a path. `!<command>` runs a shell command directly (still gated). `Ctrl+C` aborts the in-flight request and returns to the prompt.

### Permission modes

- **ask** (default) — read/glob/grep run free; write/edit/bash prompt with a preview (a colored diff for edits, the exact command for bash). Approve once with *always* to whitelist it for the session.
- **plan** — every mutating tool is refused.
- **yolo** — everything runs without prompting, except commands matching `rm -rf`, `git push --force`, `dd`, `mkfs`, `curl | sh`, `> /dev/…`, and mutating HTTP methods (`POST`/`PUT`/`PATCH`/`DELETE`), which always prompt.

## Tools

`read` · `write` · `edit` · `bash` · `glob` · `grep` · `http` — zod schemas are the source of truth; JSON Schema (for the API) and TS types are both derived from them. In multi-tab sessions the model additionally gets `send_message` / `list_tabs`.

### `http`

Make an outbound HTTP(S) request: `{ url, method?, headers?, body?, timeout? }` (default `GET`, 30s timeout). Returns the status, response headers, and body (JSON pretty-printed), truncated at 2000 lines / 50KB like the other tools; follows up to 5 redirects.

- **Permission** — `GET`/`HEAD` may auto-approve in yolo; `POST`/`PUT`/`PATCH`/`DELETE` always prompt with the full URL, in every mode.
- **SSRF guard** (hard block, never prompted) — `localhost`, `127.0.0.1`, `0.0.0.0`, `::1`, the private ranges (`10.x`, `192.168.x`, `172.16–31.x`), the cloud-metadata address `169.254.169.254`, and any non-`http(s)` scheme (`file://`, `ftp://`, …). Redirect targets are re-checked on every hop.
- **Secrets** — reference a key by name as `${VAR_NAME}` in the url, a header value, or the body. The value is read from `~/.dom/.env` (`NAME=value` lines, `#` comments, optional quotes) at request time and substituted in. Keys never enter message history, session files, or the transcript: the echoed request shows the `${VAR}` verbatim, and `Authorization` / `api-key`-style headers render as `<redacted>`. A missing key errors with the variable name and the file to add it to.

The **public-apis skill** (`~/.dom/skills/public-apis/`) caches the [public-apis](https://github.com/public-apis/public-apis) index to `~/.dom/cache/public-apis.md` (refreshed at most every 30 days), greps it by category, reports the Auth column honestly (many "free" entries still need a key), HEAD-checks links before recommending them, then calls `http`.

## Storage

- `~/.dom/config.json` — model, mode, apiKey
- `~/.dom/.env` — `NAME=value` secrets, substituted into `http` requests as `${NAME}` (never logged)
- `~/.dom/models.json` — model catalog cache (24h TTL)
- `~/.dom/sessions/<id>.json` — history, cwd, cumulative cost (written after every turn)
- `~/.dom/cache/` — code-maintained skill data (e.g. the public-apis index)
- `~/.dom/skills/<name>/SKILL.md` — skills advertised in the system prompt (also `./.dom/skills/`)
- `AGENTS.md` in the working directory, if present, is appended to the system prompt.

## Build order

`provider → tools → loop → headless CLI → permission gate → Ink UI → banner → sessions`. The loop is runnable without the TUI (`dom --headless`) so it can be verified independently.

## Verify

`npm run build && npm run verify` runs the offline regression suite in `verify/`: model resolution + `:batch` filtering, 429 backoff, the rejection-loop guard, the `http` gate + secret substitution/redaction, the multi-tab controller (loop guards + badging), a real `Banner` render (asserting no model line), and a headless Ink mount of the TUI driving `/new` + `/tabs`. Each suite runs in its own process, mocks the network, and isolates `$USERPROFILE` — nothing touches your real `~/.dom`.

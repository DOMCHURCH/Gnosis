<!--
  banner gradient: cyan (#22d3ee) → indigo (#6366f1) → magenta (#d946ef),
  left-to-right across the wordmark
-->
```
  ██████╗ ███╗   ██╗ ██████╗ ███████╗██╗███████╗
 ██╔════╝ ████╗  ██║██╔═══██╗██╔════╝██║██╔════╝
 ██║  ███╗██╔██╗ ██║██║   ██║███████╗██║███████╗
 ██║   ██║██║╚██╗██║██║   ██║╚════██║██║╚════██║
 ╚██████╔╝██║ ╚████║╚██████╔╝███████║██║███████║
  ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝ ╚══════╝╚═╝╚══════╝
```

# Gnosis — terminal coding agent

> **Gnosis** was formerly released as **dom**. The `dom` command still works as an alias, and `window.domOffice` remains available in the web UI.

**Run any model. Switch mid-session. History survives.**
**12x cheaper via prompt caching. Verified live.**

[![CI](https://github.com/DOMCHURCH/Gnosis/actions/workflows/ci.yml/badge.svg)](https://github.com/DOMCHURCH/Gnosis/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@dominquechurch/gnosis)](https://www.npmjs.com/package/@dominquechurch%2Fgnosis)
[![License: MIT](https://img.shields.io/badge/License-MIT-cyan.svg)](LICENSE)
[![OpenRouter](https://img.shields.io/badge/powered%20by-OpenRouter-blueviolet)](https://openrouter.ai)

![Gnosis office floor](docs/screenshot.png)
*The 3D office floor — a Three.js scene of five lit rooms, agents at desks, live sessions, file browser, goal bar*

| Feature | Gnosis | Claude Code | Aider | OpenCode |
|---|---|---|---|---|
| Any OpenRouter model | ✓ | ✗ | ✓ | ✓ |
| Mid-session model switch | ✓ | ✗ | ✗ | ✓ |
| Self-hosted browser UI | ✓ | ✗ | ✗ | ✓ |
| LAN QR code (drive it from your phone) | ✓ | ✗ | ✗ | ✗ |
| Obsidian vault memory | ✓ | ✗ | ✗ | ✗ |
| MCP client | ✓ | ✓ | ✗ | ✓ |
| 3D office floor (Three.js) | ✓ | ✗ | ✗ | ✗ |
| Built by a 16yo | ✓ | ✗ | ✗ | ✗ |

## Install

```sh
npx @dominquechurch/gnosis
```

`npx` works without a global install — easiest way to try it. To keep it around:

```sh
npm install -g @dominquechurch/gnosis
echo "OPENROUTER_API_KEY=sk-or-..." >> ~/.dom/.env
gnosis
```

I built Gnosis in two weeks before starting Grade 12. I wanted Claude Code but provider-agnostic, with a browser UI I could watch while agents worked. The office floor started as a joke and became the thing everyone notices first.

## Why Gnosis

Most coding agents lock you to one model. Gnosis runs on any of hundreds of models via OpenRouter — switch from Sonnet to DeepSeek mid-session and your history survives intact. Verified live.

It is **Windows-first**, where most tools treat Windows as an afterthought: real path handling, a working ConPTY terminal, and CI that runs the full suite on `windows-latest`.

Prompt caching gives a **measured ~12× cost reduction** on cached turns.

And the browser UI is not a dashboard bolted on the side — it is a live **Three.js office floor**: five lit rooms you can orbit and zoom, where every agent, background job, and sub-agent is a blocky figure at a desk, working in real time.

## What it has

- **12x prompt cache cost reduction** — measured live: $0.0252 → $0.0021 on identical tokens via Anthropic `cache_control` breakpoints
- **Any OpenRouter model, switched at runtime** — `/model` mid-session, no restart, conversation history carries over
- **Browser UI with a 3D office floor** — a Three.js scene you can orbit: agents as blocky figures in five lit rooms (coordinator, planning, coding, application, sub-agents), each showing what it is doing right now
- **MCP client** — connect Context7, Playwright, Chrome DevTools, or any MCP server
- **Obsidian vault memory** — browse your vault, save messages as notes, and auto-save by intent into `Code/`, `Decisions/`, and `Research/`
- **Sub-agents with isolated context budgets** — parallel or scoped work on a restricted tool set, with per-sub-agent cost accounting
- **Tree-sitter repo map, PageRank-ranked** — structural map of the codebase with the most central files first, so edits are grounded
- **Web terminal, file browser, diff viewer, webhook inspector** — a real ConPTY shell in the browser, streaming diffs, and a replayable webhook capture buffer
- **Goal bar with an automated verifier loop** — hold an agent to a goal; a read-only reviewer checks each turn's diff and steers it back on fail
- **Automatic outcome evaluation** — after any turn that touches files, a read-only verifier judges the diff against your request and reports `✓ outcome: … (94% confidence)`. On a fail, one button feeds the critique back
- **Security scanning on every write** — API keys, tokens, private keys, and hardcoded passwords block the auto-commit before it happens. The write always stands; `/commit --force` overrides
- **`ask_user`** — the agent can stop and ask instead of guessing when two approaches are equally valid and the wrong one means rework
- **Surgical rewind** — double-Esc opens the last 20 turns: rewind to one, or summarize everything before it into a single block via the oracle model
- **Phone-first task assignment** — on a phone, one button opens a full-screen composer: *Code it* or *Research it*, then lock the screen and get a browser notification when it needs you
- **99 automated test suites** — offline, isolated, run on every push
- **BYOK** — your key stays in `~/.dom/.env`, and there is no telemetry

![Gnosis model picker](docs/screenshot-model-picker.png)
*Runtime model switching — full OpenRouter catalog in the browser*

Also in the box: 16 built-in tools (`read`, `write`, `edit`, `glob`, `grep`, `bash`, `http`, `web_search`, `task`, `todo`, `memory`, `oracle`, `view_image`, `ask_user`, `send_message`, `list_tabs`), multi-session tabs, inter-agent messaging, a skills system, plan mode, hooks, and auto-commit on every successful edit.

## Optional keys

```sh
BRAVE_API_KEY=BSA...             # enables the web_search tool (Brave Search API)
```

To route `groq/`-prefixed models natively to Groq, add a Groq key to `~/.dom/config.json`:

```json
{ "groqApiKey": "gsk_..." }
```

## Usage

```sh
gnosis                       # start the TUI
gnosis serve                 # start the web UI (office floor, file browser, terminal)
gnosis -p "prompt"           # pipe mode: one turn, final answer to stdout, exit
```

`gnosis serve` prints a **LOCAL** and a **LAN** URL, with one scannable QR code for the LAN one — point your phone's camera at it to drive the same session from the couch. (A loopback QR would be useless: the only thing that scans one is a phone, which cannot reach `127.0.0.1`.) Both URLs carry the session token, which is what gates access.

Common in-session slash commands:

- `/model` — switch the active model (session-scoped)
- `/serve` — start the web server from inside a running session
- `/vault` — switch the working root to your configured Obsidian vault
- `/init` — generate an `AGENTS.md` for the current repo
- `/map` — show the tree-sitter repo map
- `/plan` — enter plan mode (propose before editing)
- `/yolo` — allow all tools (dangerous commands still prompt)
- `/cost` — show token usage and spend for the session
- `/undo` — revert the last agent commit
- `/jobs` — list background jobs
- `/eval` — judge whether the last turn actually succeeded (`/fix` feeds a failure back)
- `/rewind` — pick a turn to rewind to, or summarize up to (also double-Esc)
- `/security scan <path>` — scan a file for exposed keys

Type `@` to attach files and `/` to autocomplete commands.

## Keys & network

**Your key never leaves your machine.** Keys are read at request time from `~/.dom/.env` (or `~/.dom/config.json` for Groq), are never bundled with the package, and are never sent anywhere except the service they belong to. **There is no telemetry — Gnosis does not phone home.**

Gnosis makes outbound HTTP(S) requests to:

- **OpenRouter** (`openrouter.ai`) — every model call, plus the public `/models` catalog. Uses `OPENROUTER_API_KEY`.
- **Groq** (`api.groq.com`) — only when you run a `groq/`-prefixed model; fetches its `/models` and routes chat completions natively. Uses `groqApiKey` from `~/.dom/config.json`. Skipped entirely if no Groq key is set.
- **Brave Search** (`api.search.brave.com`) — the `web_search` tool. Uses `BRAVE_API_KEY`. Skipped if unset.
- **Arbitrary public hosts** — the `http` tool fetches URLs you (or the agent) request. Loopback, private-network, and cloud-metadata addresses are refused. Secrets are never inlined: reference them as `${VAR_NAME}` and the value is pulled from `~/.dom/.env` at send time.

See [SECURITY.md](SECURITY.md) for the permission model and how the `gnosis serve` token gate works.

## Development

```sh
git clone https://github.com/DOMCHURCH/Gnosis.git
cd Gnosis
npm install
npm run build
npm link
npm run verify      # 99 test suites
npm run eval        # 10-task eval harness
```

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the test conventions, how to add a skill, and PR guidelines.

---

MIT © 2026 Dominique Church

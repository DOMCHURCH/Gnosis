<!--
  banner gradient: cyan (#22d3ee) → indigo (#6366f1) → magenta (#d946ef),
  left-to-right across the wordmark
-->
```
██████╗   ██████╗  ███╗   ███╗
██╔══██╗ ██╔═══██╗ ████╗ ████║
██║  ██║ ██║   ██║ ██╔████╔██║
██║  ██║ ██║   ██║ ██║╚██╔╝██║
██████╔╝ ╚██████╔╝ ██║ ╚═╝ ██║
╚═════╝   ╚═════╝  ╚═╝     ╚═╝
```

**dom** is a terminal coding agent that runs entirely on OpenRouter (bring your own key), lets you switch models mid-session, and ships with a web UI that visualizes your agents as figures moving around an office floor.

![dom office floor](docs/screenshot.png)
*Office floor — manual agents across all zones, two live sessions, file browser, goal bar*

## Features

- **OpenRouter BYOK** — one provider, your own key; no vendor lock-in, no bundled credits
- **Runtime model switching** — change the model mid-session with `/model`, no restart

![dom model picker](docs/screenshot-model-picker.png)
*Runtime model switching — full OpenRouter catalog in the browser*

- **10 built-in tools** — read, write, edit, multi-edit, bash, HTTP, web search, tree-sitter repo map, todo, and more
- **Sub-agents** — spawn isolated agents for parallel or scoped work
- **Repo map** — tree-sitter structural map of your codebase for grounded edits
- **Prompt caching** — measured ~12× cost reduction on cached turns
- **Multi-session tabs** — run several agents side by side, each with its own context
- **Inter-agent messaging** — tabs can message each other to coordinate
- **Skills system** — reusable, invokable capabilities the agent loads on demand
- **Auto-commit** — each successful write/edit is committed to git (toggle with `--no-auto-commit`)
- **Plan mode** — the agent proposes a plan and waits for approval before touching code
- **Hooks** — run your own commands on agent lifecycle events
- **Web UI** — office-floor visualization of live agents, a file browser, an in-browser terminal, and a per-tab goal bar

## Install

```sh
npm install -g dom-agent      # or, from source: npm link
```

Add your OpenRouter key to `~/.dom/.env`:

```sh
OPENROUTER_API_KEY=sk-or-...     # required — all model calls route through OpenRouter
BRAVE_API_KEY=BSA...             # optional — enables the web_search tool (Brave Search API)
```

Optional: to route `groq/`-prefixed models natively to Groq, add a Groq key to `~/.dom/config.json`:

```json
{ "groqApiKey": "gsk_..." }
```

Then run it:

```sh
dom
```

## Usage

```sh
dom                       # start the TUI
dom serve                 # start the web UI (office floor, file browser, terminal)
dom -p "prompt"           # pipe mode: one turn, final answer to stdout, exit
```

Common in-session slash commands:

- `/model` — switch the active model (session-scoped)
- `/serve` — start the web server from inside a running session
- `/init` — generate an `AGENTS.md` for the current repo
- `/map` — show the tree-sitter repo map
- `/plan` — enter plan mode (propose before editing)
- `/yolo` — allow all tools (dangerous commands still prompt)
- `/cost` — show token usage and spend for the session
- `/undo` — revert the last agent commit
- `/jobs` — list background jobs

Type `@` to attach files and `/` to autocomplete commands.

## Keys & network

All keys are yours and stay local — read at request time from `~/.dom/.env` (or `~/.dom/config.json` for Groq), never bundled with the package, and never sent anywhere except the service they belong to. There is no telemetry.

dom makes outbound HTTP(S) requests to:

- **OpenRouter** (`openrouter.ai`) — every model call, plus the public `/models` catalog. Uses `OPENROUTER_API_KEY`.
- **Groq** (`api.groq.com`) — only when you run a `groq/`-prefixed model; fetches its `/models` and routes chat completions natively. Uses `groqApiKey` from `~/.dom/config.json`. Skipped entirely if no Groq key is set.
- **Brave Search** (`api.search.brave.com`) — the `web_search` tool. Uses `BRAVE_API_KEY`. Skipped if unset.
- **Arbitrary public hosts** — the `http` tool fetches URLs you (or the agent) request. Loopback, private-network, and cloud-metadata addresses are refused. Secrets are never inlined: reference them as `${VAR_NAME}` and the value is pulled from `~/.dom/.env` at send time.

## Development

```sh
git clone https://github.com/DOMCHURCH/dom.git
cd dom
npm install
npm run build
npm link
npm run verify      # 68 test suites
npm run eval        # 10-task eval harness
```

---

MIT © 2026 Dominique Church

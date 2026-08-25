# Contributing to dom

Thanks for taking the time. dom is a terminal coding agent with a browser UI —
the whole thing is TypeScript, and everything ships from this one repo.

## Running it locally

```sh
git clone https://github.com/DOMCHURCH/Gnosis.git
cd Gnosis
npm install
npm run build      # tsc → dist/, then vite → dist/web/
npm link           # puts `dom` on your PATH, pointing at this checkout
dom
```

`npm link` symlinks the global `dom` command to your working copy, so a rebuild
is enough to pick up changes — no reinstall. Undo it later with
`npm unlink -g @dominquechurch/gnosis`.

You need an OpenRouter key in `~/.dom/.env` before dom will do anything:

```sh
OPENROUTER_API_KEY=sk-or-...
```

While iterating, `npm run dev` runs `tsc --watch`. The web bundle is a separate
step — rerun `npm run build:web` after touching anything under `web/`.

## Running the tests

```sh
npm run build      # required first: the suites import from dist/
npm run verify     # the full regression suite
npm run eval       # 10-task eval harness (scores agent behaviour, not correctness)
```

`npm run verify` is the gate. It runs every `verify/s*.mjs` suite in its own
process and exits non-zero if any of them fail. Suites are self-contained and
offline — `fetch` is mocked, nothing touches the network, and each isolates
itself to a throwaway home directory rather than your real `~/.dom`.

**Every change needs a suite.** Add `verify/sNN-<topic>.mjs` alongside your
feature and follow the house pattern:

```js
let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

ok("a plain-English description of the behaviour", actual === expected);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
```

Two conventions worth knowing:

- **Web logic that needs testing is authored as plain `.js` + a `.d.ts`.** Vite
  bundles `web/`, and only `src/` goes through `tsc` into `dist/` — so a suite
  can import `web/src/sessions.js` directly and run the exact code the browser
  runs. Keep the pure model there and the React in the `.tsx`.
- **Verify against the real thing.** If a change affects the `dom` binary or
  `dom serve`, exercise the actual command, not just the module. Suites have
  shipped green while the command itself was broken.

CI runs `npm ci && npm run build && npm run verify` on `windows-latest`, Node 20.

## Adding a skill

Skills are named procedures the model reads on demand. Each is a folder with a
`SKILL.md` in it:

```
~/.dom/skills/<name>/SKILL.md     # global — available everywhere
./.dom/skills/<name>/SKILL.md     # project-local — shadows a global of the same name
```

The file is YAML frontmatter over a free-form Markdown body:

```markdown
---
name: release-check
description: Use before tagging a release — runs the build, the suite, and checks the changelog.
---

1. `npm run build` and confirm it exits 0.
2. `npm run verify` — all suites must pass.
3. Check `CHANGELOG.md` has an entry for the version in `package.json`.
```

Both `name` and `description` are **required** — a skill missing either is
skipped with a warning at boot. Only the frontmatter is parsed and advertised in
the system prompt; the body is never loaded until the model decides the task
matches and reads the file itself. So write the `description` as the trigger
("use when…"), and put the actual procedure in the body.

At most 40 skills are advertised, to keep the prompt bounded.

## Pull requests

- **One feature per PR.** A PR that adds a tool *and* refactors the event bus is
  two PRs. Small and reviewable beats complete.
- **`npm run verify` must pass.** Run it locally before pushing; CI will run it
  again. If you had to change an existing suite, say why in the PR body — that's
  usually a sign the behaviour genuinely changed, and it needs to be deliberate.
- **Name the feature in the commit message.** The subject line should say what
  landed, not how you got there: `add webhook inspector to the web UI`, not
  `fixes` or `wip`. Explain the reasoning in the body.
- **Match the surrounding code.** dom's source is heavily commented with *why*,
  not *what*. Follow the density and voice of the file you're editing.
- **No new dependencies without a reason in the PR body.** dom stays
  dependency-light on purpose — the WebSocket layer is hand-rolled for exactly
  this reason.

## Reporting bugs and security issues

Bugs and feature requests go through the
[issue templates](https://github.com/DOMCHURCH/Gnosis/issues/new/choose).

Security vulnerabilities do **not** — see [SECURITY.md](SECURITY.md) for the
private reporting channel.

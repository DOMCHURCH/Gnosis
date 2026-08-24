# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.** A public issue is visible
to everyone the moment it is filed, including before there is a fix.

Report it privately through GitHub:

> **Security** tab → **Report a vulnerability**

That opens a [private security advisory][advisory] visible only to the
maintainer. It is the right channel for anything that could let someone read
files, run commands, exfiltrate a key, or reach a `dom serve` instance they
should not.

Please include:

- what you found, and which version (`dom --version`) it affects
- how to reproduce it — a minimal case is worth more than a long report
- what an attacker could actually do with it

Expect an acknowledgement within 72 hours. Please give a fix a reasonable window
before disclosing publicly.

[advisory]: https://github.com/DOMCHURCH/dom/security/advisories/new

## What dom can reach

dom is a coding agent. By design it holds capabilities that are dangerous if
misdirected, so it is worth being explicit about what they are.

| Capability | What it can do |
| --- | --- |
| **Filesystem** | Read, write, and edit files. Reads are scoped to the working root; writes go through the permission gate. |
| **Shell** | `bash` runs real commands on your machine, with your user's privileges. |
| **Network** | The `http` tool fetches URLs. Loopback, private-network, and cloud-metadata addresses are refused, so it cannot be turned into an SSRF pivot into your LAN. |
| **Sub-agents** | Spawned agents get a restricted tool set. `write`, `edit`, `bash`, `send_message`, `list_tabs`, and `task` are hard-blocked and cannot be granted back. |

### The permission model

Every mutating action is gated before it runs. There are three modes:

- **`ask`** (default) — every write, edit, `bash` command, and unsafe HTTP method
  prompts, showing a preview first: the full diff for a file edit, the exact
  command for `bash`, the method and URL for HTTP.
- **`plan`** — read-only. Mutating tools are rejected outright, so the agent can
  investigate and propose without being able to touch anything.
- **`yolo`** — allows tools without prompting. **Commands classified as
  dangerous still prompt even here**, and that list is not user-overridable.

Approving an action once (`always`) scopes that allowance to the session, not to
disk. Nothing you approve in one session carries into the next.

Two details worth knowing, because they exist specifically to stop the preview
from lying to you:

- Commands are normalized before classification, so an obfuscated variant of a
  dangerous command cannot slip past the check by being spelled differently.
- Commands containing hidden or bidirectional Unicode characters are flagged —
  those are the trick that makes a command preview render as something other
  than what will execute.

## `dom serve` and the token gate

`dom serve` exposes a web UI that **drives the same engines** the terminal
session does. Anyone who can reach it and authenticate can read your transcript,
browse your filesystem, open a shell through the web terminal, and approve the
agent's permission prompts. It is remote control, not a dashboard.

Three things gate it:

1. **A per-startup token.** A fresh random token is generated every time the
   server starts and is required on every HTTP request and WebSocket connect. It
   appears in the printed URL and QR code — nowhere else. **Without the token
   there is no access.** The token is the access control; reachability alone
   grants nothing.
2. **A Host-header allowlist.** Only loopback names and private LAN IPv4
   addresses are accepted. A request arriving under any public hostname is
   refused, which blocks DNS rebinding.
3. **Session lifetime.** The token dies with the process. Stopping the server
   (`/serve stop`, or Ctrl+C) invalidates every URL and QR code that was printed.

The server binds `0.0.0.0` so a phone on the same Wi-Fi can scan the LAN QR and
connect. That is deliberate, and it is safe *because* of the token — but it does
mean the printed URL is a credential. Treat the QR code like a password: anyone
you show it to gets full control of that session for as long as it runs.

`--public` additionally opens a Cloudflare Tunnel, putting the UI on the open
internet behind the same token. Only use it when you mean to.

## Your API keys

Keys are read at request time from `~/.dom/.env` (and `~/.dom/config.json` for
Groq). They are:

- **never bundled** with the published package
- **never written** into transcripts, sessions, or the Obsidian vault
- **never sent anywhere except the service they belong to** — your OpenRouter key
  goes to OpenRouter, your Brave key to Brave, and nowhere else

There is no telemetry. dom does not phone home, and no usage data leaves your
machine.

The `http` tool never inlines secrets. Reference them as `${VAR_NAME}` and the
value is substituted from `~/.dom/.env` at send time, so a key cannot end up in
a URL the model composed — or in the transcript.

If you think a key has leaked, rotate it at the provider first; that
invalidates it immediately, which no local cleanup can do.

## Supported versions

dom is pre-1.0 and moves fast. Fixes land on `master` and ship in the next
release; there are no backported patch branches yet.

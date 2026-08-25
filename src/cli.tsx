#!/usr/bin/env node
import { render } from "ink";
import { maybeRebuild } from "./selfbuild.js";
import { parseArgs, boot, BootError } from "./startup.js";
import { runHeadless } from "./headless.js";
import { runPipe } from "./pipe.js";
import { runJson } from "./jsonrun.js";
import { runScheduleCommand } from "./scheduler.js";
import { startServer, type ServerHandle } from "./server.js";
import { EventBus, createBridge, type AppBridge } from "./events.js";
import { App } from "./ui/App.js";
import { detectCaps, termWidth } from "./ui/terminal.js";
import { getGhAuth, getRepoInfo } from "./gitinfo.js";

const VERSION = "0.1.0";

const HELP = `Gnosis — terminal coding agent (OpenRouter)

usage:
  gnosis [message]              start the TUI (optionally send an opening message in --headless)
  gnosis -c                     resume the latest session for this directory
  gnosis -r <id>                resume a specific session
  gnosis --model <id>           start with a specific model
  gnosis --yolo                 allow all tools without prompting (dangerous commands still prompt)
  gnosis --no-auto-commit       don't commit each successful write/edit to git
  gnosis --headless [message]   run without the TUI (plain stdout)
  gnosis -p "prompt"            pipe mode: read stdin, run one turn, print the result, exit
  gnosis -p "prompt" --save     ...and persist the one-shot turn as a session
  gnosis --json "prompt"        headless: stream structured JSONL events to stdout, exit
  gnosis schedule <sub>         manage/fire scheduled runs (add|list|remove|run|tick|daemon)
  gnosis serve [--port 7777] [--public]          TUI + web view (LOCAL + LAN QR always; --public: tunnel)
  gnosis --help | --version

Pipe mode composes in shell pipelines, e.g.  git diff | gnosis -p "review this".
JSON mode is the machine contract (web UI / scripts): one JSON object per line,
ending with a {"type":"result"} line. Reads piped stdin too, like -p.

Set OPENROUTER_API_KEY in your environment, or put { "apiKey": "sk-or-..." } in ~/.dom/config.json.`;

async function main() {
  const argv = process.argv.slice(2);

  // Before anything loads the app: if the compiled output is stale relative to
  // src/ or web/src/, rebuild and re-exec on the fresh build (skipped by
  // DOM_NO_BUILD, and a no-op when already current). Resolved from the install
  // root, so it's correct from any working directory.
  maybeRebuild(argv);

  // `dom schedule ...` manages/fires scheduled runs — handled before flag parsing
  // so the subcommand words aren't mistaken for an opening prompt.
  if (argv[0] === "schedule") {
    process.exit(await runScheduleCommand(argv.slice(1)));
  }

  const flags = parseArgs(argv);
  if (flags.version) {
    console.log(`gnosis ${VERSION}`);
    return;
  }
  if (flags.help) {
    console.log(HELP);
    return;
  }

  let bootResult;
  try {
    bootResult = await boot(flags, process.cwd());
  } catch (e) {
    if (e instanceof BootError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  const { engine, resumed, skillWarnings, defaultModel } = bootResult;

  // JSON mode: one non-interactive turn, structured JSONL to stdout, exit. Checked
  // before -p (and the TTY fallback) so `--json` wins if both are passed. stdout is
  // pure JSONL; the resumed notice and skill warnings go to stderr.
  if (flags.json) {
    if (resumed) process.stderr.write(`resumed session ${engine.sessionId()}\n`);
    for (const w of skillWarnings) process.stderr.write(`\x1b[2m! ${w}\x1b[0m\n`);
    const code = await runJson(engine, { prompt: flags.prompt, save: flags.save });
    process.exit(code);
  }

  // Pipe mode: one non-interactive turn, result to stdout, exit. Checked BEFORE the
  // TTY-based headless fallback so `git diff | dom -p "…"` (stdin not a TTY) hits it.
  if (flags.print) {
    if (resumed) process.stderr.write(`resumed session ${engine.sessionId()}\n`);
    for (const w of skillWarnings) process.stderr.write(`\x1b[2m! ${w}\x1b[0m\n`);
    const code = await runPipe(engine, { prompt: flags.prompt, save: flags.save });
    process.exit(code);
  }

  // The TUI needs an interactive stdin (raw mode). Fall back to headless otherwise.
  if (!flags.serve && (flags.headless || !process.stdin.isTTY || !process.stdout.isTTY)) {
    if (resumed) process.stderr.write(`resumed session ${engine.sessionId()}\n`);
    for (const w of skillWarnings) process.stderr.write(`\x1b[2m! ${w}\x1b[0m\n`);
    await runHeadless(engine, { prompt: flags.prompt });
    return;
  }

  // `dom serve`: start the localhost web server. The tokenized URL is the FIRST
  // stdout output (so it can't be lost), then either the TUI mounts (attached
  // terminal) or the server runs headless (browser-driven). Both share the bus.
  let bridge: AppBridge | undefined;
  let server: ServerHandle | undefined;
  if (flags.serve) {
    bridge = createBridge(new EventBus());
    try {
      server = await startServer(bridge, { port: flags.port });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        console.error(`gnosis serve: port ${flags.port ?? 7777} is already in use. Pick another with --port <n>.`);
      } else {
        console.error(`gnosis serve: could not start the server — ${(e as Error).message}`);
      }
      process.exit(1);
    }
    // Optional Cloudflare Tunnel so `dom serve` is reachable from any device. The
    // public URL carries the SAME session token, so the token gate still protects it.
    let publicUrl: string | null = null;
    if (flags.public) {
      try {
        const { startTunnel } = await import("./tunnel.js");
        const t = await startTunnel(server.port);
        publicUrl = `${t.url}/?token=${server.token}`;
        server.setPublicUrl(t.url);
        const stop = () => t.stop();
        process.on("exit", stop);
        process.on("SIGINT", stop);
      } catch (e) {
        process.stdout.write(`(public tunnel unavailable: ${(e as Error).message} — continuing local-only)\n`);
      }
    }
    // No terminal attached → the browser drives the engines. WIRE IT BEFORE the
    // URL is printed: the server is already listening, so a browser that connects
    // the instant it sees the URL must find a populated agent roster. Wiring after
    // the print leaves a window — widened by this dynamic import on a cold disk —
    // where `bridge.getAgents()` is still the empty default and the client's
    // opening snapshot carries no agents at all.
    const headless = !process.stdin.isTTY || !process.stdout.isTTY;
    if (headless) {
      const { wireServeHost } = await import("./servehost.js");
      wireServeHost(engine, bridge);
    }

    // First output, on STDOUT, before the banner/TUI so it's always visible. Each URL
    // is followed by a scannable QR code so a phone doesn't have to type the token.
    const { serveBlock } = await import("./serveprint.js");
    // LOCAL and LAN are both always printed (LAN needs no flag); the LAN line is
    // omitted only when the machine genuinely has no non-loopback address.
    const links: { label: string; url: string; scannable?: boolean }[] = [{ label: "LOCAL ", url: server.url, scannable: false }];
    if (server.lanUrl) links.push({ label: "LAN   ", url: `${server.lanUrl}/?token=${server.token}` });
    if (publicUrl) links.push({ label: "PUBLIC", url: publicUrl });
    const scope = server.lanUrl ? "LAN + loopback" : "loopback only (no LAN address)";
    process.stdout.write(`gnosis serve — scan or open:\n${await serveBlock(links)}\n(${scope} · token required · Ctrl+C to stop)\n\n`);

    // Already wired above — just stay alive until Ctrl+C.
    if (headless) {
      await new Promise<void>(() => {});
      return;
    }
  }

  // Interactive: file edits get a diff preview + confirm prompt (headless applies directly).
  engine.interactive = true;

  // Interactive boot wipes the screen + scrollback so the banner opens at the top
  // of a clean terminal — but NOT under `dom serve`, where that would erase the URL
  // printed just above. Never do this in headless mode.
  if (!flags.serve) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

  const caps = detectCaps();
  const [ghAuth, initialRepo] = await Promise.all([getGhAuth(), getRepoInfo(engine.cwd)]);

  const { waitUntilExit } = render(
    <App
      engine={engine}
      caps={caps}
      width={termWidth()}
      ghAuth={ghAuth}
      initialRepo={initialRepo}
      skillWarnings={skillWarnings}
      defaultModel={defaultModel}
      bridge={bridge}
      serveHandle={server}
    />,
    { exitOnCtrlC: false },
  );
  await waitUntilExit();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

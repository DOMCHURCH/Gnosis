#!/usr/bin/env node
import { render } from "ink";
import { parseArgs, boot, BootError } from "./startup.js";
import { runHeadless } from "./headless.js";
import { App } from "./ui/App.js";
import { detectCaps, termWidth } from "./ui/terminal.js";
import { getGhAuth, getRepoInfo } from "./gitinfo.js";

const VERSION = "0.1.0";

const HELP = `dom — terminal coding agent (OpenRouter)

usage:
  dom [message]              start the TUI (optionally send an opening message in --headless)
  dom -c                     resume the latest session for this directory
  dom -r <id>                resume a specific session
  dom --model <id>           start with a specific model
  dom --yolo                 allow all tools without prompting (dangerous commands still prompt)
  dom --headless [message]   run without the TUI (plain stdout)
  dom --help | --version

Set OPENROUTER_API_KEY in your environment, or put { "apiKey": "sk-or-..." } in ~/.dom/config.json.`;

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.version) {
    console.log(`dom ${VERSION}`);
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
  const { engine, resumed, skillWarnings } = bootResult;

  // The TUI needs an interactive stdin (raw mode). Fall back to headless otherwise.
  if (flags.headless || !process.stdin.isTTY || !process.stdout.isTTY) {
    if (resumed) process.stderr.write(`resumed session ${engine.sessionId()}\n`);
    for (const w of skillWarnings) process.stderr.write(`\x1b[2m! ${w}\x1b[0m\n`);
    await runHeadless(engine, { prompt: flags.prompt });
    return;
  }

  // Interactive: file edits get a diff preview + confirm prompt (headless applies directly).
  engine.interactive = true;

  // Interactive boot only: wipe the screen + scrollback so the banner opens at
  // the top of a clean terminal. Never do this in headless mode.
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

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
    />,
    { exitOnCtrlC: false },
  );
  await waitUntilExit();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

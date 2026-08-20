#!/usr/bin/env node
import { render } from "ink";
import { parseArgs, boot, BootError } from "./startup.js";
import { runHeadless } from "./headless.js";
import { runPipe } from "./pipe.js";
import { runJson } from "./jsonrun.js";
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
  dom --no-auto-commit       don't commit each successful write/edit to git
  dom --headless [message]   run without the TUI (plain stdout)
  dom -p "prompt"            pipe mode: read stdin, run one turn, print the result, exit
  dom -p "prompt" --save     ...and persist the one-shot turn as a session
  dom --json "prompt"        headless: stream structured JSONL events to stdout, exit
  dom --help | --version

Pipe mode composes in shell pipelines, e.g.  git diff | dom -p "review this".
JSON mode is the machine contract (web UI / scripts): one JSON object per line,
ending with a {"type":"result"} line. Reads piped stdin too, like -p.

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
      defaultModel={defaultModel}
    />,
    { exitOnCtrlC: false },
  );
  await waitUntilExit();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

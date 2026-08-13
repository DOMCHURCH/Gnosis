// Headless runner. Drives the engine with plain stdout — used to verify the loop
// works before the TUI exists, and available via `dom --headless`.

import readline from "node:readline";
import { Engine, type Callbacks } from "./engine.js";
import type { Preview, PermissionAnswer } from "./permissions.js";
import type { ToolCall } from "./messages.js";
import type { ToolResult } from "./tools/index.js";

const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => c("2", s);
const cyan = (s: string) => c("36", s);
const green = (s: string) => c("32", s);
const red = (s: string) => c("31", s);
const magenta = (s: string) => c("35", s);

function previewText(p: Preview): string {
  if (p.kind === "bash") {
    const warn = p.warning ? `\n${red("⚠ " + p.warning)}` : "";
    return `${p.dangerous ? red("⚠ ") : ""}$ ${p.command}\n${dim("in " + p.cwd)}${warn}`;
  }
  if (p.kind === "http") {
    const warn = p.warning ? `\n${red("⚠ " + p.warning)}` : "";
    return `${p.dangerous ? red("⚠ ") : ""}${p.method} ${p.url}${warn}`;
  }
  // diff — headless never prompts for file edits, but render for type completeness.
  const body = p.lines
    .map((l) => (l.kind === "add" ? green(l.text) : l.kind === "del" ? red(l.text) : l.text))
    .join("\n");
  const warn = p.warning ? `\n${red("⚠ " + p.warning)}` : "";
  return `${p.tool} ${dim(p.absPath)}${warn}\n${body}${p.moreLines ? `\n(+${p.moreLines} more lines)` : ""}`;
}

function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise((res) => rl.question(q, res));
}

export async function runHeadless(engine: Engine, opts: { prompt?: string }): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const cb: Callbacks = {
    onLine(line) {
      if (line.kind === "rule") {
        process.stdout.write(dim("───" + (line.lang ? " " + line.lang : "")) + "\n");
      } else {
        process.stdout.write(line.text + "\n");
      }
    },
    onPending() {
      // Headless streams finalized lines only — no transient region to update.
    },
    onAssistant(msg) {
      for (const call of msg.calls ?? []) {
        process.stdout.write(dim(`\n  ⚙ ${call.name}\n`));
      }
    },
    onToolStart(call: ToolCall, args) {
      process.stdout.write(dim(`  → ${call.name} ${JSON.stringify(args).slice(0, 120)}\n`));
    },
    onToolResult(_call, result: ToolResult) {
      const head = result.output.split("\n").slice(0, 8).join("\n");
      process.stdout.write((result.isError ? red("  ✗ ") : green("  ✓ ")) + head.replace(/\n/g, "\n    ") + "\n");
    },
    onSystem(text) {
      process.stdout.write(dim(`\n${text}\n`));
    },
    async requestPermission(preview): Promise<PermissionAnswer> {
      process.stdout.write("\n" + previewText(preview) + "\n");
      const a = (await ask(rl, "allow? [y]es / [n]o / [a]lways: ")).trim().toLowerCase();
      if (a === "a" || a === "always") return "always";
      if (a === "y" || a === "yes") return "yes";
      return "no";
    },
  };

  const oneTurn = async (text: string) => {
    process.stdout.write(magenta("\n❯ ") + text + "\n");
    await engine.run(text, cb);
    process.stdout.write("\n");
  };

  if (opts.prompt) {
    await oneTurn(opts.prompt);
    rl.close();
    return;
  }

  process.stdout.write(cyan("dom headless — type a message, or /exit to quit\n"));
  while (true) {
    const line = (await ask(rl, magenta("\n❯ "))).trim();
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    await engine.run(line, cb);
    process.stdout.write("\n");
  }
  rl.close();
}

// Pipe mode: `dom -p "prompt"` runs ONE turn non-interactively and writes the
// model's final answer to stdout, so it composes in shell pipelines
// (`git diff | dom -p "review this"`). Piped stdin, when present, is appended to
// the prompt. Progress and errors go to STDERR so stdout stays clean. No session
// file is written unless --save. Returns the process exit code (0 ok, 1 error).

import { Engine, type Callbacks } from "./engine.js";

/** Read all of stdin when it's piped (not a TTY); "" for an interactive terminal. */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  } catch {
    /* stdin closed early — use whatever we got */
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runPipe(engine: Engine, opts: { prompt?: string; save?: boolean }): Promise<number> {
  const piped = await readStdin();
  // The -p argument is the instruction; piped stdin (e.g. a diff) is the material.
  const prompt = [opts.prompt?.trim(), piped.trim()].filter((s): s is string => !!s).join("\n\n");
  if (!prompt) {
    process.stderr.write('dom -p: nothing to do — pass a prompt (dom -p "…") or pipe input (… | dom -p "…").\n');
    return 1;
  }

  engine.noPersist = !opts.save; // one-shot: no session file unless --save

  const useColor = !!process.stderr.isTTY && !process.env.NO_COLOR;
  const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);

  let lastText = "";
  let errored = false;
  const cb: Callbacks = {
    onLine() {}, // the final answer is taken raw from the assistant message below
    onPending() {},
    onAssistant(msg) {
      if (msg.text) lastText = msg.text; // last non-empty assistant text = the answer
    },
    onToolStart(call) {
      process.stderr.write(dim(`  → ${call.name}`) + "\n");
    },
    onToolResult(call, result) {
      process.stderr.write(dim(`  ${result.isError ? "✗" : "✓"} ${call.name}`) + "\n");
      if (result.isError) errored = true;
    },
    onSystem(text) {
      process.stderr.write(dim(text) + "\n");
      if (text.startsWith("✗")) errored = true;
    },
    // Non-interactive: refuse anything that needs confirmation (bash/http prompts).
    // Read-only work and (non-interactive) file edits proceed as in headless mode.
    requestPermission: async () => "no",
  };

  await engine.run(prompt, cb);

  const out = lastText.trim();
  if (out) process.stdout.write(out + "\n");
  // Error, or the turn produced no textual answer at all → non-zero exit.
  return errored || !out ? 1 : 0;
}

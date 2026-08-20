// Headless JSON mode: `dom -p "prompt" --json` (or `dom --json "prompt"`) runs ONE
// turn non-interactively and emits a structured event stream as newline-delimited
// JSON (JSONL) to stdout — one complete JSON object per line, terminated by a
// {"type":"result"} line. This is the machine contract a web UI or any programmatic
// caller consumes; human-readable progress (resumed notice, skill warnings) goes to
// stderr so stdout stays pure JSONL.
//
// Event types, in stream order:
//   {type:"session", sessionId, model, cwd}          once, first
//   {type:"assistant", text}                          each assistant text message
//   {type:"tool_use", id, name, input}                a tool call (input redacted)
//   {type:"tool_result", id, name, ok, output}        its result (output redacted upstream)
//   {type:"system", text}                             a system notice
//   {type:"permission", answer:"no", preview}         a prompt auto-denied (headless)
//   {type:"cost", usd, promptTokens, completionTokens, cachedTokens}  per turn
//   {type:"result", ok, text, usd, sessionId, capped} once, last
//
// Secrets are redacted in tool inputs, permission previews, and assistant/result
// text before they reach stdout (tool *outputs* are already redacted upstream by
// the engine). Execution always used the real values — redaction is display-only.

import { Engine, type Callbacks, type TurnCost } from "./engine.js";
import type { ToolCall } from "./messages.js";
import type { ToolResult } from "./tools/index.js";
import type { Preview, PermissionAnswer } from "./permissions.js";
import { redactSecrets } from "./redact.js";
import { readStdin } from "./pipe.js";

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/** Redact secrets from a structured value while keeping it structured: stringify,
 * redact the text, re-parse. Falls back to the redacted string if it no longer
 * parses (a secret straddling JSON punctuation — vanishingly rare). */
function redactValue(value: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(value ?? null);
  } catch {
    return null;
  }
  const red = redactSecrets(json).text;
  if (red === json) return value;
  try {
    return JSON.parse(red);
  } catch {
    return red;
  }
}

export async function runJson(engine: Engine, opts: { prompt?: string; save?: boolean }): Promise<number> {
  const piped = await readStdin();
  // The -p/positional argument is the instruction; piped stdin (e.g. a diff) is material.
  const prompt = [opts.prompt?.trim(), piped.trim()].filter((s): s is string => !!s).join("\n\n");
  if (!prompt) {
    emit({ type: "result", ok: false, error: "no input — pass a prompt or pipe stdin", sessionId: engine.sessionId() });
    return 1;
  }

  engine.noPersist = !opts.save; // one-shot: no session file unless --save
  emit({ type: "session", sessionId: engine.sessionId(), model: engine.modelId, cwd: engine.cwd });

  let lastText = "";
  let errored = false;
  const cb: Callbacks = {
    onLine() {}, // the final answer is taken from onAssistant below
    onPending() {},
    onAssistant(msg) {
      if (msg.text) {
        const text = redactSecrets(msg.text).text;
        lastText = text;
        emit({ type: "assistant", text });
      }
    },
    onToolStart(call: ToolCall, args: unknown) {
      emit({ type: "tool_use", id: call.id, name: call.name, input: redactValue(args) });
    },
    onToolResult(call: ToolCall, result: ToolResult) {
      if (result.isError) errored = true;
      emit({ type: "tool_result", id: call.id, name: call.name, ok: !result.isError, output: result.output });
    },
    onSystem(text) {
      if (text.startsWith("✗")) errored = true;
      emit({ type: "system", text });
    },
    onTurnCost(cost: TurnCost) {
      emit({
        type: "cost",
        usd: cost.usd,
        promptTokens: cost.promptTokens,
        completionTokens: cost.completionTokens,
        cachedTokens: cost.cachedTokens,
      });
    },
    // Non-interactive: refuse anything that needs confirmation, but record it so a
    // consumer can see what dom wanted to do (and re-run with --yolo if appropriate).
    async requestPermission(preview: Preview): Promise<PermissionAnswer> {
      emit({ type: "permission", answer: "no", preview: redactValue(preview) });
      return "no";
    },
  };

  await engine.run(prompt, cb);

  const text = lastText.trim();
  const ok = !errored && !!text && engine.capped !== "budget";
  emit({ type: "result", ok, text, usd: engine.cost.usd, sessionId: engine.sessionId(), capped: engine.capped });
  return ok ? 0 : 1;
}

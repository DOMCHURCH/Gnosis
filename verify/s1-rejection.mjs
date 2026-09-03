// Verify 1c: rejecting the same write twice ends the turn (no identical-retry loop).
// Isolated to a fake home so persisted sessions never touch the real ~/.dom.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(here, "_fakehome");
process.env.USERPROFILE = HOME;
process.env.HOME = process.env.USERPROFILE;

import { existsSync, rmSync } from "node:fs";
import { Engine } from "../dist/engine.js";
import { createSession } from "../dist/config.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "✓" : "✗"} ${name}`); if (!cond) fails++; };

const TARGET = path.join(here, "_work", "reject-target.txt");
if (existsSync(TARGET)) rmSync(TARGET);

// The model always answers with the SAME write call (the "retries identically" bug).
const toolArgs = JSON.stringify({ path: TARGET, content: "hi" });
const delta = { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "write", arguments: toolArgs } }] } }] };
const usageChunk = { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } };
const sse = `data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(usageChunk)}\n\ndata: [DONE]\n\n`;
globalThis.fetch = async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });

const model = { id: "openai/gpt-4o-mini", name: "GPT-4o mini", context_length: 128000, pricing: { prompt: 0, completion: 0 }, supported_parameters: ["tools"] };
const session = createSession(process.cwd(), model.id, "ask");
const engine = new Engine({ apiKey: "test", cwd: process.cwd(), systemPrompt: "test", models: [model], session, skills: [] });
engine.interactive = true; // so a write goes through the diff-confirm prompt

let permCalls = 0;
const systems = [];
const cb = {
  onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult() {},
  onSystem(t) { systems.push(t); },
  async requestPermission() { permCalls++; return "no"; }, // user declines every time
};

await engine.run("write the file", cb);

ok("declined write prompted exactly twice, then stopped (not looping)", permCalls === 2);
ok("turn announced it ended after the 2nd decline", systems.some((s) => /declined twice/i.test(s)));
ok("the rejected write was never applied (file absent)", !existsSync(TARGET));

// Clean up the isolated fake home so the tree stays tidy.
try { rmSync(HOME, { recursive: true, force: true }); } catch {}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

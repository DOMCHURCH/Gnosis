// Verify (feature 4 — plan mode with teeth): plan mode advertises only the 4
// read-only tools; write/edit/bash are absent AND refused if hallucinated; the
// model produces a plan and makes no writes; switching to ask (what /approve does)
// re-enables execution.
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { Engine } = await import("../dist/engine.js");
const { createSession } = await import("../dist/config.js");
const { toolDefinitions } = await import("../dist/tools/index.js");

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const sse = (b) => new Response(b, { status: 200, headers: { "content-type": "text/event-stream" } });
const planText = `data: {"choices":[{"delta":{"content":"Plan: edit engine.ts to add X."}}]}\n\ndata: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n`;
const toolSSE = (name, args) =>
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n` +
  `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n`;

let pending = null, served = false;
globalThis.fetch = async () => {
  if (pending && !served) { served = true; return sse(toolSSE(pending.name, pending.args)); }
  return sse(planText);
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dom-plan-"));
const prevCwd = process.cwd();
process.chdir(dir);
const model = { id: "anthropic/claude-sonnet-4.6", name: "S", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"] };
const engine = new Engine({ apiKey: "test", cwd: dir, systemPrompt: "SYS", models: [model], session: createSession(dir, model.id, "plan"), skills: [], autoCommit: false });

async function turn(name, args) {
  pending = name ? { name, args } : null; served = false;
  const results = [];
  await engine.run("go", { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult(_c, r) { results.push(r); }, onSystem() {}, async requestPermission() { return "yes"; } });
  return results[0];
}

// --- plan mode advertises exactly the 5 non-mutating tools ---------------------
// read/glob/grep/http, plus ask_user: planning is when an ambiguous requirement
// most deserves a question, and ask_user writes nothing.
{
  const names = engine.availableToolNames();
  ok("plan mode exposes exactly 5 tools", names.length === 5);
  ok("...they are read/glob/grep/http (read-only)", ["read", "glob", "grep", "http"].every((n) => names.includes(n)));
  ok("...plus ask_user, which mutates nothing", names.includes("ask_user"));
  ok("...write/edit/bash are absent from the tool list", !names.includes("write") && !names.includes("edit") && !names.includes("bash"));
  const defs = toolDefinitions(engine.availableToolNames()).map((d) => d.function.name);
  ok("the API tool schema list also has only those 5", defs.length === 5 && !defs.includes("write"));
  ok("the plan-mode directive is appended to the system prompt", /PLAN MODE/.test(engine.currentSystemPrompt()));
}

// --- a write attempt in plan mode is refused; nothing is written ---------------
{
  const r = await turn("write", { path: "hello.py", content: "x\n" });
  ok("a hallucinated write in plan mode is refused", r.isError && /not available in plan mode/i.test(r.output));
  ok("...and no file is created", !existsSync(path.join(dir, "hello.py")));
}

// --- the model still produces a written plan (text, no tool call) --------------
{
  await turn(null); // plain text turn
  const last = [...engine.messages].reverse().find((m) => m.role === "assistant" && m.text);
  ok("the model produces a written plan", !!last && /Plan:/.test(last.text));
}

// --- ask mode (what /approve switches to) re-enables the full tool set + writes -
{
  engine.setMode("ask");
  ok("ask mode restores all tools", engine.availableToolNames().length > 4 && engine.availableToolNames().includes("write"));
  const r = await turn("write", { path: "hello.py", content: "print('hi')\n" });
  ok("after approve→ask, a write executes", !r.isError && existsSync(path.join(dir, "hello.py")));
}

process.chdir(prevCwd);
await fs.rm(dir, { recursive: true, force: true });
await fs.rm(fake, { recursive: true, force: true });
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

// Verify (0.2 — trajectory tracing): the engine appends one JSONL line per user
// turn, model call, and tool call to ~/.dom/traces/<session>.jsonl; readTrace +
// summarizeTrace aggregate it; ephemeral (noPersist) engines do NOT trace.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { appendTrace, readTrace, summarizeTrace, formatTraceSummary, traceFile } = await import("../dist/trace.js");
const { Engine } = await import("../dist/engine.js");
const { createSession } = await import("../dist/config.js");

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

// --- module: append / read / summarize --------------------------------------
{
  const sid = "unit-session";
  await appendTrace(sid, { type: "turn", role: "user", text: "hi" });
  await appendTrace(sid, { type: "model_call", model: "m1", promptTokens: 100, completionTokens: 20, cachedTokens: 40, cost: 0.01, toolCalls: 1 });
  await appendTrace(sid, { type: "tool_call", name: "read", args: { path: "a.ts" }, isError: false, outputChars: 500 });
  await appendTrace(sid, { type: "tool_call", name: "read", args: { path: "b.ts" }, isError: true, outputChars: 10 });
  const events = await readTrace(sid);
  ok("appendTrace writes JSONL that readTrace reads back", events.length === 4);
  const s = summarizeTrace(events);
  ok("summarize counts turns/model/tool calls", s.turns === 1 && s.modelCalls === 1 && s.toolCalls === 2 && s.toolErrors === 1);
  ok("summarize sums tokens + cost + per-tool", s.promptTokens === 100 && s.cachedTokens === 40 && s.cost === 0.01 && s.byTool.read === 2);
  ok("formatTraceSummary is a readable multi-line summary", /trace: 4 events/.test(formatTraceSummary(sid, s)) && /read×2/.test(formatTraceSummary(sid, s)));
}

// --- engine writes a trace during a real turn -------------------------------
const sse = (b) => new Response(b, { status: 200, headers: { "content-type": "text/event-stream" } });
const done = `data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":30,"completion_tokens":5,"cost":0.002}}\n\ndata: [DONE]\n\n`;
const toolSSE = (name, args) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\ndata: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":20,"completion_tokens":3,"cost":0.001}}\n\ndata: [DONE]\n\n`;
let served = false;
globalThis.fetch = async (url) => {
  if (String(url).includes("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
  if (!served) { served = true; return sse(toolSSE("read", { path: "file.txt" })); }
  return sse(done);
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dom-tr-"));
await fs.writeFile(path.join(dir, "file.txt"), "hello\n");
const model = { id: "m", name: "M", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"], input_modalities: ["text"] };
const session = createSession(dir, "m", "yolo");
const engine = new Engine({ apiKey: "test", cwd: dir, systemPrompt: "t", models: [model], session, skills: [], autoCommit: false });

await engine.run("read the file", { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult() {}, onSystem() {}, async requestPermission() { return "yes"; } });

{
  const events = await readTrace(engine.sessionId());
  const s = summarizeTrace(events);
  ok("engine traced the user turn", s.turns === 1 && events.some((e) => e.type === "turn" && e.text === "read the file"));
  ok("engine traced BOTH model calls (tool-call iter + final)", s.modelCalls === 2);
  ok("engine traced the read tool call", s.toolCalls === 1 && s.byTool.read === 1);
  ok("model-call tokens accumulate in the trace", s.promptTokens === 50 && s.completionTokens === 8);
  ok("the trace file lives under ~/.dom/traces", traceFile(engine.sessionId()).includes(path.join(".dom", "traces")));
}

// --- ephemeral engines do NOT trace -----------------------------------------
{
  served = false;
  const eph = new Engine({ apiKey: "test", cwd: dir, systemPrompt: "t", models: [model], session: createSession(dir, "m", "yolo"), skills: [], autoCommit: false });
  eph.noPersist = true;
  await eph.run("read the file", { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult() {}, onSystem() {}, async requestPermission() { return "yes"; } });
  const events = await readTrace(eph.sessionId());
  ok("a noPersist (ephemeral) engine writes no trace", events.length === 0);
}

await fs.rm(dir, { recursive: true, force: true });
try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

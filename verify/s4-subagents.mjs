// Verify (feature 7 — sub-agents): the task tool returns a short summary; the
// parent history contains only that summary, not the sub-agent's tool calls; a
// sub-agent's write is refused as an unknown tool; the iteration cap terminates
// cleanly with a truncation note; cost is attributed + tracked separately.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { Engine } = await import("../dist/engine.js");
const { createSession } = await import("../dist/config.js");

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const sse = (b) => new Response(b, { status: 200, headers: { "content-type": "text/event-stream" } });
const usage = `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":50,"completion_tokens":10,"cost":0.001}}\n\ndata: [DONE]\n\n`;
const textSSE = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n${usage}`;
const toolSSE = (name, args) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n${usage}`;

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dom-sub-"));
const prevCwd = process.cwd();
process.chdir(dir);
await fs.mkdir(path.join(dir, "src"));
await fs.writeFile(path.join(dir, "src", "permissions.ts"), "export function gate() {}\n");
const model = { id: "anthropic/claude-sonnet-4.6", name: "S", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"] };
const mkEngine = (mode = "ask") => new Engine({ apiKey: "test", cwd: dir, systemPrompt: "SYS", models: [model], session: createSession(dir, model.id, mode), skills: [], autoCommit: false });

async function turn(engine, pending) {
  let served = false;
  globalThis.__pending = pending;
  const results = [];
  await engine.run("go", { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult(c, r) { results.push({ name: c.name, r }); }, onSystem() {}, async requestPermission() { return "no"; } });
  return results;
}

// --- (3) a sub-agent (allow-list engine) refuses write as an unknown tool ------
{
  let served = false;
  globalThis.fetch = async () => { if (!served) { served = true; return sse(toolSSE("write", { path: "x.txt", content: "hi" })); } return sse(textSSE("done")); };
  const sub = mkEngine("yolo");
  sub.toolAllowList = ["read", "glob", "grep", "http"]; // the sub-agent tool set
  const results = await turn(sub);
  const w = results.find((x) => x.name === "write");
  ok("a sub-agent's write is refused as an unknown tool", w && w.r.isError && /unknown tool: write/.test(w.r.output));
}

// --- routing mock: parent turns vs sub-agent turns (by system prompt) ----------
let subMode = "summarize";
let subCalls = 0, parentCalls = 0;
const resetMock = (mode) => { subMode = mode; subCalls = 0; parentCalls = 0; };
globalThis.fetch = async (_u, init) => {
  const sys = String(JSON.parse(init.body).messages?.[0]?.content ?? "");
  if (/research sub-agent/i.test(sys)) {
    subCalls++;
    if (subMode === "loop") return sse(toolSSE("grep", { pattern: "x" }));
    if (subCalls === 1) return sse(toolSSE("grep", { pattern: "gate" }));
    return sse(textSSE("Permissions are gated in src/permissions.ts via the gate() function."));
  }
  parentCalls++;
  if (parentCalls === 1) return sse(toolSSE("task", { description: "find where permissions are gated", prompt: "where are permissions gated?" }));
  return sse(textSSE("done"));
};

// --- (1,2) task returns a summary; parent history excludes sub-agent tool calls -
{
  resetMock("summarize");
  const engine = mkEngine("ask");
  const results = await turn(engine);
  const t = results.find((x) => x.name === "task");
  ok("the task tool returns the sub-agent's summary", t && !t.r.isError && /gated in src\/permissions\.ts/.test(t.r.output));
  ok("the result carries the one-line accounting (tools · tokens)", /\d+ tool.*·.*\d+ tokens/.test(t.r.output));
  const toolMsgs = engine.messages.filter((m) => m.role === "tool");
  ok("parent history has the task result", toolMsgs.some((m) => m.name === "task"));
  ok("parent history does NOT contain the sub-agent's own tool calls (grep)", !toolMsgs.some((m) => m.name === "grep"));
  ok("the parent transcript only ever sees the task call, never the sub-agent's tool calls", results.every((x) => x.name === "task"));
  ok("sub-agent cost is folded into the session and tracked separately", (engine.cost.subAgentUsd ?? 0) > 0 && engine.cost.usd >= engine.cost.subAgentUsd);
}

// --- (bug 2) the sub-agent searches the PARENT's cwd, even if process.cwd drifted
{
  const saved = globalThis.fetch;
  let gc = 0;
  let pc = 0;
  let grepOut = "";
  globalThis.fetch = async (_u, init) => {
    const msgs = JSON.parse(init.body).messages;
    if (/research sub-agent/i.test(String(msgs?.[0]?.content ?? ""))) {
      gc++;
      if (gc === 1) return sse(toolSSE("grep", { pattern: "gate" }));
      grepOut = String([...msgs].reverse().find((m) => m.role === "tool")?.content ?? "");
      return sse(textSSE("reported"));
    }
    pc++;
    return pc === 1 ? sse(toolSSE("task", { description: "x", prompt: "find gate" })) : sse(textSSE("done"));
  };
  const engine = mkEngine("ask"); // engine.cwd = dir (has src/permissions.ts with gate())
  process.chdir(fake); // drift process.cwd away from the engine's working root
  await turn(engine);
  process.chdir(dir);
  ok("the sub-agent grep searched the parent's cwd, not the drifted process.cwd", /permissions\.ts/.test(grepOut) && !/No matches/.test(grepOut));
  globalThis.fetch = saved;
}

// --- (4) the iteration cap terminates cleanly with a truncation note -----------
{
  resetMock("loop");
  const engine = mkEngine("ask");
  const results = await turn(engine);
  const t = results.find((x) => x.name === "task");
  ok("a looping sub-agent stops at the iteration cap (no hang)", !!t);
  ok("...and the result says it was truncated at the cap", /truncated: hit the iteration cap/i.test(t.r.output));
}

process.chdir(prevCwd);
await fs.rm(dir, { recursive: true, force: true });
await fs.rm(fake, { recursive: true, force: true });
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

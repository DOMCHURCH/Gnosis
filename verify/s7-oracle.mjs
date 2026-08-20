// Verify (1.5 — oracle tool): oracle(question) runs a SINGLE completion on the
// configured oracleModel, with NO tools and an ISOLATED context (only the
// question — no session history), returns just the answer, and attributes its
// dollar spend separately (cost.oracleUsd). Falls back to the session model when
// oracleModel is unset. Excluded from plan mode.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;
await fs.mkdir(path.join(fake, ".dom"), { recursive: true });
await fs.writeFile(path.join(fake, ".dom", "config.json"), JSON.stringify({ oracleModel: "strong-model" }));

const { Engine } = await import("../dist/engine.js");
const { createSession } = await import("../dist/config.js");

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const sse = (b) => new Response(b, { status: 200, headers: { "content-type": "text/event-stream" } });
const textUsage = (text, u) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":${u.p},"completion_tokens":${u.c},"cost":${u.cost}}}\n\ndata: [DONE]\n\n`;
const toolSSE = (name, args) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\ndata: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":1,"cost":0.001}}\n\ndata: [DONE]\n\n`;

let oracleReq = null;
let served = false;
globalThis.fetch = async (_u, init) => {
  const body = JSON.parse(init.body);
  const model = body.model;
  const sys = String(body.messages?.[0]?.content ?? "");
  if (model === "strong-model" || model === "session-model" && /expert consultant/.test(sys)) {
    if (/expert consultant/.test(sys)) { oracleReq = { model, tools: body.tools, messages: body.messages }; return sse(textUsage("The answer is 4.", { p: 12, c: 4, cost: 0.05 })); }
  }
  if (!served) { served = true; return sse(toolSSE("oracle", { question: "what is 2+2? explain briefly" })); }
  return sse(textUsage("done", { p: 5, c: 1, cost: 0.001 }));
};

const model = { id: "session-model", name: "S", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"], input_modalities: ["text"] };
const strong = { id: "strong-model", name: "Strong", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"], input_modalities: ["text"] };
const mkEngine = () => new Engine({ apiKey: "test", cwd: fake, systemPrompt: "SESSION SYSTEM PROMPT", models: [model, strong], session: createSession(fake, "session-model", "yolo"), skills: [], autoCommit: false });

// --- plan-mode exclusion / ask availability ---------------------------------
{
  const e = new Engine({ apiKey: "k", cwd: fake, systemPrompt: "t", models: [model], session: createSession(fake, "session-model", "plan"), skills: [], autoCommit: false });
  ok("oracle is NOT available in plan mode", !e.availableToolNames().includes("oracle"));
  e.setMode("ask");
  ok("oracle IS available in ask mode", e.availableToolNames().includes("oracle"));
}

// --- a turn that calls oracle -----------------------------------------------
const engine = mkEngine();
const results = [];
await engine.run("solve a hard thing", { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult(c, r) { results.push({ name: c.name, r }); }, onSystem() {}, async requestPermission() { return "yes"; } });

const oracleResult = results.find((x) => x.name === "oracle");
ok("oracle returns the answer with an accounting header", oracleResult && !oracleResult.r.isError && /The answer is 4/.test(oracleResult.r.output) && /strong-model/.test(oracleResult.r.output) && /\$0\.05/.test(oracleResult.r.output));
ok("oracle ran on the configured oracleModel (not the session model)", oracleReq && oracleReq.model === "strong-model");
ok("oracle sent NO tools (single tool-less turn)", oracleReq && (!oracleReq.tools || oracleReq.tools.length === 0));
ok("oracle used an ISOLATED context (system + the question only, no session history)", oracleReq && oracleReq.messages.length === 2 && oracleReq.messages[1].role === "user" && String(oracleReq.messages[1].content).includes("what is 2+2") && !JSON.stringify(oracleReq.messages).includes("solve a hard thing"));
ok("oracle cost is attributed separately (cost.oracleUsd)", Math.abs((engine.cost.oracleUsd ?? 0) - 0.05) < 1e-9);
ok("oracle spend is included in the session total", engine.cost.usd >= 0.05);

// --- fallback to session model when oracleModel unset -----------------------
await fs.writeFile(path.join(fake, ".dom", "config.json"), JSON.stringify({}));
{
  oracleReq = null; served = false;
  const e2 = mkEngine();
  await e2.run("again", { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult() {}, onSystem() {}, async requestPermission() { return "yes"; } });
  ok("oracle falls back to the session model when oracleModel is unset", oracleReq && oracleReq.model === "session-model");
}

try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

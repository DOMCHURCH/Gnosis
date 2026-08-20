// Verify (1.3 — per-turn cost): the engine fires onTurnCost once per turn with
// THAT turn's token/dollar delta (not the running session total), including cached
// tokens. Two sequential turns each report their own numbers.
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
const textUsage = (u) =>
  `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n` +
  `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":${u.p},"completion_tokens":${u.c},"cost":${u.cost},"prompt_tokens_details":{"cached_tokens":${u.cached}}}}\n\n` +
  `data: [DONE]\n\n`;

const usages = [{ p: 30, c: 5, cost: 0.002, cached: 0 }, { p: 40, c: 6, cost: 0.003, cached: 10 }];
let call = 0;
globalThis.fetch = async (url) => {
  if (String(url).includes("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
  const u = usages[Math.min(call, usages.length - 1)];
  call++;
  return sse(textUsage(u));
};

const model = { id: "m", name: "M", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"], input_modalities: ["text"] };
const engine = new Engine({ apiKey: "test", cwd: fake, systemPrompt: "t", models: [model], session: createSession(fake, "m", "yolo"), skills: [], autoCommit: false });

const costs = [];
const cb = { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult() {}, onSystem() {}, onTurnCost(c) { costs.push(c); }, async requestPermission() { return "yes"; } };

await engine.run("turn one", cb);
await engine.run("turn two", cb);

ok("onTurnCost fires once per turn", costs.length === 2);
ok("turn 1 reports its own delta (30 in, 5 out, $0.002)", costs[0].promptTokens === 30 && costs[0].completionTokens === 5 && Math.abs(costs[0].usd - 0.002) < 1e-9 && costs[0].cachedTokens === 0);
ok("turn 2 reports ITS delta, not the cumulative total (40 in, 6 out, $0.003)", costs[1].promptTokens === 40 && costs[1].completionTokens === 6 && Math.abs(costs[1].usd - 0.003) < 1e-9);
ok("turn 2 delta includes its cached tokens (10)", costs[1].cachedTokens === 10);
ok("session total is the SUM of the per-turn deltas", engine.cost.promptTokens === 70 && engine.cost.completionTokens === 11 && Math.abs(engine.cost.usd - 0.005) < 1e-9);

try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

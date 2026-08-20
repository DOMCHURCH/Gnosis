// Verify (2.6 — budget ceiling): on reaching maxSessionUsd the engine prompts;
// "no" halts the turn (capped=budget), "yes" grants another allotment, "always"
// lifts it; while over budget, sub-agent and oracle spawns are refused.
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
const usage = (c) => `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":1,"cost":${c}}}\n\ndata: [DONE]\n\n`;
const textSSE = (t, c) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n${usage(c)}`;
const toolSSE = (name, args, c) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n${usage(c)}`;
const model = { id: "m", name: "M", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"], input_modalities: ["text"] };

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dom-bud-"));
// call 1 (glob, cost 0.02) pushes cost over the $0.01 ceiling; call 2 is text.
globalThis.fetch = async (url) => {
  if (String(url).includes("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
  return sse(globalThis.__step());
};
let n = 0;
globalThis.__step = () => (n++ === 0 ? toolSSE("glob", { pattern: "*" }, 0.02) : textSSE("done", 0.02));

const runWith = async (answer) => {
  n = 0;
  const e = new Engine({ apiKey: "test", cwd: dir, systemPrompt: "t", models: [model], session: createSession(dir, "m", "yolo"), skills: [], autoCommit: false, maxSessionUsd: 0.01 });
  e.interactive = true; // so the ceiling prompts (headless would just halt)
  const sys = [];
  await e.run("go", { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult() {}, onSystem(t) { sys.push(t); }, async requestPermission() { return answer; } });
  return { e, sys };
};

// --- "no" halts the turn ----------------------------------------------------
{
  const { e, sys } = await runWith("no");
  ok("reaching the ceiling with 'no' halts the turn (capped=budget)", e.capped === "budget");
  ok("...with an actionable halt message", sys.some((t) => /halted at the \$0\.01 budget ceiling/.test(t)));
}

// --- "yes" grants another allotment -----------------------------------------
{
  const { e, sys } = await runWith("yes");
  ok("'yes' continues past the ceiling (not capped)", e.capped !== "budget");
  ok("...and raises the ceiling by one allotment", Math.abs(e.budgetCeiling - 0.02) < 1e-9 && sys.some((t) => /ceiling raised to \$0\.02/.test(t)));
}

// --- "always" lifts the ceiling for the session -----------------------------
{
  const { e, sys } = await runWith("always");
  ok("'always' lifts the ceiling (Infinity) for the session", e.budgetCeiling === Infinity && sys.some((t) => /lifted for this session/.test(t)));
}

// --- over budget refuses sub-agent + oracle spawns --------------------------
{
  const e = new Engine({ apiKey: "test", cwd: dir, systemPrompt: "t", models: [model], session: createSession(dir, "m", "yolo"), skills: [], autoCommit: false, maxSessionUsd: 2 });
  e.cost.usd = 5; // already over the $2 ceiling
  ok("overBudget() reflects the cost vs ceiling", e.overBudget() === true);
  const sub = await e.runSubAgent("x", "find something");
  ok("a sub-agent spawn is refused while over budget", /budget ceiling/.test(sub.text) && sub.capped === "budget");
  const orc = await e.runOracle("hard question");
  ok("an oracle spawn is refused while over budget", /budget ceiling/.test(orc.text) && orc.usd === 0);
}

await fs.rm(dir, { recursive: true, force: true });
try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

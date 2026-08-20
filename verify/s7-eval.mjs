// Verify (0.1 — eval harness machinery): drive the harness with a DETERMINISTIC
// mock model (a fetch that replays each task's known-good tool trajectory) so the
// scoring/baseline/delta logic is provable offline. Asserts: a healthy run scores
// 10/10 and records a baseline; a run under a deliberately BROKEN (sabotaged)
// system prompt scores lower and the diff flags a negative score delta.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { TASKS } = await import("../eval/tasks.mjs");
const { runAll, saveBaseline, loadBaseline, diffBaseline } = await import("../eval/harness.mjs");
const { Engine } = await import("../dist/engine.js");
const { createSession } = await import("../dist/config.js");

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const sse = (b) => new Response(b, { status: 200, headers: { "content-type": "text/event-stream" } });
const usage = `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":2,"cost":0}}\n\ndata: [DONE]\n\n`;
const textSSE = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n${usage}`;
const toolSSE = (name, args) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n${usage}`;

const SABOTAGE = "SABOTAGE-PROMPT";

// Mock model: match the running task by its user prompt, replay solution.calls in
// order (counting tool results already in history), then answer. Under a sabotaged
// system prompt, do nothing and give a useless answer so every task fails.
globalThis.fetch = async (_u, init) => {
  const body = JSON.parse(init.body);
  const msgs = body.messages;
  const sys = String(msgs[0]?.content ?? "");
  const userMsg = String(msgs.find((m) => m.role === "user")?.content ?? "");
  const task = TASKS.find((t) => t.prompt === userMsg);
  if (!task) return sse(textSSE("?"));
  if (sys.includes(SABOTAGE)) return sse(textSSE("I cannot help with that."));
  const done = msgs.filter((m) => m.role === "tool").length;
  const sol = task.solution;
  if (done < sol.calls.length) { const c = sol.calls[done]; return sse(toolSSE(c.tool, c.args)); }
  return sse(textSSE(sol.answer));
};

const model = { id: "m", name: "M", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"], input_modalities: ["text"] };
const makeEngine = (systemPrompt) => async (dir) => {
  const e = new Engine({ apiKey: "test", cwd: dir, systemPrompt, models: [model], session: createSession(dir, "m", "yolo"), skills: [], autoCommit: false });
  e.interactive = false;
  e.noPersist = true;
  return e;
};

// --- healthy run: 10/10, baseline records ------------------------------------
const healthy = await runAll(TASKS, makeEngine("You are a careful coding agent."));
ok(`healthy run scores ${healthy.passed}/${healthy.total} (all tasks pass)`, healthy.passed === TASKS.length);
ok("the run records per-task tokens", Object.values(healthy.tasks).every((t) => t.tokens > 0));

const baselineFile = path.join(fake, "baseline.json");
await saveBaseline(baselineFile, healthy, "2020-01-01T00:00:00.000Z");
const baseline = await loadBaseline(baselineFile);
ok("baseline is recorded and reloads", !!baseline && baseline.passed === TASKS.length && baseline.recordedAt === "2020-01-01T00:00:00.000Z");

// --- broken system prompt: score drops, diff flags a regression --------------
const broken = await runAll(TASKS, makeEngine(`You are a coding agent. ${SABOTAGE}`));
ok("a deliberately broken system prompt drops the score", broken.passed < baseline.passed);
const d = diffBaseline(baseline, broken);
ok("diffBaseline reports a negative score delta", d.scoreDelta < 0 && d.scoreDelta === broken.passed - baseline.passed);
ok("diffBaseline lists the regressed tasks", d.regressed.length === baseline.passed - broken.passed && d.regressed.length > 0);

// --- a partial regression is detected per-task -------------------------------
{
  // Same-quality run but drop ONE task by faking its baseline as passing-then-failing.
  const oneWorse = { ...healthy, passed: healthy.passed - 1, tasks: { ...healthy.tasks, "write-file": { name: "write-file", pass: false, tokens: 5, usd: 0 } } };
  const d2 = diffBaseline(baseline, oneWorse);
  ok("a single-task regression is flagged by name", d2.scoreDelta === -1 && d2.regressed.includes("write-file"));
}

try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

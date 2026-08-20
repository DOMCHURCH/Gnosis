// Eval harness machinery: run a task in a scratch repo, score it, aggregate, and
// diff against a stored baseline. Model-agnostic — the caller supplies a
// `makeEngine(dir)` factory (a real engine in run-eval.mjs, a mock in the verify
// suite), so the scoring/baseline logic is testable offline without API calls.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Run one task: scratch dir -> setup -> engine.run(prompt) -> check. */
export async function runTask(task, makeEngine) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `dom-eval-${task.name}-`));
  try {
    await task.setup(dir);
    const engine = await makeEngine(dir);
    let output = "";
    await engine.run(task.prompt, {
      onLine() {},
      onPending() {},
      onAssistant(m) { if (m.text) output = m.text; },
      onToolStart() {},
      onToolResult() {},
      onSystem() {},
      async requestPermission() { return "yes"; },
    });
    let pass = false;
    try { pass = await task.check(dir, output); } catch { pass = false; }
    const tokens = engine.cost.promptTokens + engine.cost.completionTokens;
    return { name: task.name, pass, tokens, usd: engine.cost.usd };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Run every task sequentially and aggregate a scorecard. */
export async function runAll(tasks, makeEngine, onProgress) {
  const results = [];
  for (const t of tasks) {
    const r = await runTask(t, makeEngine);
    results.push(r);
    onProgress?.(r);
  }
  const passed = results.filter((r) => r.pass).length;
  const tokens = results.reduce((s, r) => s + r.tokens, 0);
  const usd = results.reduce((s, r) => s + r.usd, 0);
  return { passed, total: tasks.length, tokens, usd, tasks: Object.fromEntries(results.map((r) => [r.name, r])) };
}

export async function loadBaseline(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
}

export async function saveBaseline(file, agg, stamp) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ recordedAt: stamp, ...agg }, null, 2) + "\n", "utf8");
}

/** Compare a fresh scorecard to the baseline: score delta + per-task regressions. */
export function diffBaseline(baseline, agg) {
  const scoreDelta = agg.passed - baseline.passed;
  const tokenDelta = agg.tokens - baseline.tokens;
  const usdDelta = agg.usd - baseline.usd;
  const regressed = [];
  const fixed = [];
  for (const name of Object.keys(agg.tasks)) {
    const now = agg.tasks[name];
    const was = baseline.tasks?.[name];
    if (!was) continue;
    if (was.pass && !now.pass) regressed.push(name);
    if (!was.pass && now.pass) fixed.push(name);
  }
  return { scoreDelta, tokenDelta, usdDelta, regressed, fixed };
}

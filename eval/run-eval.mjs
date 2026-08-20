// `npm run eval` — run the regression suite against the LIVE model and score it.
// Records/updates a baseline (eval/baseline.json) with per-task pass, tokens, and
// cost; on later runs prints the delta vs baseline so you can see what a change
// helped or hurt. Requires an OpenRouter API key (env or ~/.dom/config.json) and
// makes real (cheap-model) API calls.
//
//   npm run build && npm run eval            # score vs baseline (or record first)
//   npm run build && npm run eval -- --record  # (re)record the baseline
//   DOM_EVAL_MODEL=<id> npm run eval          # override the model

import path from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS } from "./tasks.mjs";
import { runAll, loadBaseline, saveBaseline, diffBaseline } from "./harness.mjs";
import { loadConfig, resolveApiKey, createSession } from "../dist/config.js";
import { fetchModels } from "../dist/models.js";
import { buildSystemPrompt } from "../dist/system-prompt.js";
import { Engine } from "../dist/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(here, "baseline.json");
const record = process.argv.includes("--record");

const config = await loadConfig();
const apiKey = resolveApiKey(config);
if (!apiKey) {
  console.error("eval: no OpenRouter API key (set OPENROUTER_API_KEY or ~/.dom/config.json). Cannot run the live eval.");
  process.exit(2);
}
const modelId = process.env.DOM_EVAL_MODEL || config.model || "google/gemini-2.5-flash-lite";
const models = await fetchModels();

const makeEngine = async (dir) => {
  const systemPrompt = await buildSystemPrompt(dir, [], config.mapTokens ?? 1024);
  const engine = new Engine({
    apiKey,
    cwd: dir,
    systemPrompt,
    models,
    session: createSession(dir, modelId, "yolo"), // non-interactive, no approval prompts
    skills: [],
    autoCommit: false,
  });
  engine.interactive = false;
  engine.noPersist = true;
  return engine;
};

console.log(`running ${TASKS.length} eval tasks on ${modelId}…\n`);
const agg = await runAll(TASKS, makeEngine, (r) => {
  console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(18)} ${String(r.tokens).padStart(7)} tok  $${r.usd.toFixed(4)}`);
});

console.log(`\nscore: ${agg.passed}/${agg.total}   ${agg.tokens} tokens   $${agg.usd.toFixed(4)}`);

const baseline = await loadBaseline(BASELINE);
if (baseline && !record) {
  const d = diffBaseline(baseline, agg);
  const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
  console.log(`\nvs baseline (${baseline.recordedAt}):`);
  console.log(`  score ${sign(d.scoreDelta)}   tokens ${sign(d.tokenDelta)}   cost ${d.usdDelta >= 0 ? "+" : ""}$${d.usdDelta.toFixed(4)}`);
  if (d.regressed.length) console.log(`  REGRESSED: ${d.regressed.join(", ")}`);
  if (d.fixed.length) console.log(`  fixed: ${d.fixed.join(", ")}`);
  if (!d.regressed.length && !d.fixed.length && d.scoreDelta === 0) console.log("  no score change");
} else {
  await saveBaseline(BASELINE, agg, new Date().toISOString());
  console.log(`\nbaseline ${baseline ? "re-recorded" : "recorded"} → ${path.relative(process.cwd(), BASELINE)}`);
}

process.exit(agg.passed === agg.total ? 0 : 1);

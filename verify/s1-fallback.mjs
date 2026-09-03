// Verify: fallbackModel. Upstream/shared-pool 429s and 404s don't clear on retry,
// so they switch to the fallback model (once, for the session) with a dim notice
// naming both models. Our-own 429s still retry in place. Isolated to a fake home.
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOME = path.join(path.dirname(fileURLToPath(import.meta.url)), "_fakehome");
process.env.USERPROFILE = HOME;
process.env.HOME = process.env.USERPROFILE;

import { promises as fs } from "node:fs";
import { streamCompletion, ProviderError, FallbackNeededError } from "../dist/provider.js";
import { Engine } from "../dist/engine.js";
import { createSession } from "../dist/config.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const sse = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n';
const good = () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
const upstream429 = () => new Response(JSON.stringify({ error: { message: "rate-limited", metadata: { limit_source: "upstream_provider_shared_pool" } } }), { status: 429 });
const own429 = () => new Response(JSON.stringify({ error: { message: "rate-limited", metadata: { limit_source: "key" } } }), { status: 429 });
const notFound = () => new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });

const call = (opts) =>
  streamCompletion(
    { apiKey: "test", model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }], tools: [], signal: new AbortController().signal, retry: { baseDelayMs: 1, maxRetries: 4 }, ...opts },
    () => {},
  );

// --- provider classification -------------------------------------------------
{
  let n = 0; globalThis.fetch = async () => { n++; return upstream429(); };
  let err = null; try { await call(); } catch (e) { err = e; }
  ok("upstream/shared-pool 429 → FallbackNeededError", err instanceof FallbackNeededError);
  ok("upstream 429 → flagged upstream, status 429", err?.upstream === true && err?.status === 429);
  ok("upstream 429 → NOT retried in place (1 attempt)", n === 1);
}
{
  let n = 0; globalThis.fetch = async () => { n++; return n === 1 ? own429() : good(); };
  const res = await call();
  ok("our-own 429 → still retried in place and succeeds", res.text === "ok" && n === 2);
}
{
  let n = 0; globalThis.fetch = async () => { n++; return notFound(); };
  let err = null; try { await call(); } catch (e) { err = e; }
  ok("404 → FallbackNeededError(404), not upstream, 1 attempt", err instanceof FallbackNeededError && err.status === 404 && err.upstream === false && n === 1);
  ok("FallbackNeededError is a ProviderError", err instanceof ProviderError);
}

// --- engine-level fallback switch --------------------------------------------
const primary = { id: "openai/gpt-4o-mini", name: "GPT-4o mini", context_length: 128000, pricing: { prompt: 0, completion: 0 }, supported_parameters: ["tools"] };
const fb = { id: "anthropic/claude-3.5-haiku", name: "Claude Haiku", context_length: 200000, pricing: { prompt: 0, completion: 0 }, supported_parameters: ["tools"] };

{
  // Primary model is upstream-throttled; the fallback answers fine.
  globalThis.fetch = async (_url, init) => (JSON.parse(init.body).model === primary.id ? upstream429() : good());
  const session = createSession(process.cwd(), primary.id, "ask");
  const engine = new Engine({ apiKey: "test", cwd: process.cwd(), systemPrompt: "t", models: [primary, fb], session, skills: [], fallbackModel: fb.id });
  const systems = []; const lines = [];
  await engine.run("hi", { onLine: (l) => lines.push(l.text ?? ""), onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult() {}, onSystem: (t) => systems.push(t), async requestPermission() { return "no"; } });
  ok("engine switched the active model to the fallback", engine.modelId === fb.id);
  ok("engine printed a dim notice naming BOTH models", systems.some((s) => s.includes(primary.id) && s.includes(fb.id)));
  ok("notice states the upstream reason", systems.some((s) => /upstream/i.test(s)));
  ok("the turn then completed on the fallback (got 'ok')", lines.join("").includes("ok"));
}
{
  // No fallback configured → the error surfaces, model unchanged (no silent switch).
  globalThis.fetch = async () => upstream429();
  const session = createSession(process.cwd(), primary.id, "ask");
  const engine = new Engine({ apiKey: "test", cwd: process.cwd(), systemPrompt: "t", models: [primary], session, skills: [] });
  const systems = [];
  await engine.run("hi", { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult() {}, onSystem: (t) => systems.push(t), async requestPermission() { return "no"; } });
  ok("no fallbackModel → error is surfaced (✗)", systems.some((s) => s.includes("✗")));
  ok("no fallbackModel → active model is unchanged", engine.modelId === primary.id);
}

try { await fs.rm(HOME, { recursive: true, force: true }); } catch {}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

// Verify: 413 (request too large / TPM limit) is NOT retried in place. It compacts
// + retries once; if still too large, falls back to a larger model (when set),
// else surfaces a clear error naming the limit + suggesting /compact or /clear.
process.env.USERPROFILE = "C:/Users/Dominique/dom/verify/_fakehome";
process.env.HOME = process.env.USERPROFILE;

import { promises as fs } from "node:fs";
import { streamCompletion, TooLargeError, ProviderError } from "../dist/provider.js";
import { Engine } from "../dist/engine.js";
import { createSession } from "../dist/config.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const tooLarge = () => new Response(JSON.stringify({ error: { message: "This request exceeds the tokens-per-minute (TPM) limit for this model: 30000", code: 413 } }), { status: 413 });
const good = () => new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });

// --- provider: 413 → TooLargeError, not retried -----------------------------
{
  let n = 0; globalThis.fetch = async () => { n++; return tooLarge(); };
  let err = null;
  try {
    await streamCompletion({ apiKey: "test", model: "anthropic/claude-sonnet-4.6", messages: [{ role: "user", content: "hi" }], tools: [], signal: new AbortController().signal, retry: { baseDelayMs: 1, maxRetries: 4 } }, () => {});
  } catch (e) { err = e; }
  ok("413 → TooLargeError", err instanceof TooLargeError && err instanceof ProviderError);
  ok("413 carries the limit detail", /TPM|tokens-per-minute/.test(err?.detail ?? ""));
  ok("413 is NOT retried (1 attempt, no backoff)", n === 1);
}

const primary = { id: "anthropic/claude-sonnet-4.6", name: "Sonnet", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"] };
const big = { id: "anthropic/claude-opus-4.8", name: "Opus", context_length: 1000000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"] };
const cb = () => { const systems = []; return { systems, cb: { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult() {}, onSystem: (t) => systems.push(t), async requestPermission() { return "no"; } } }; };

// --- engine, no fallback: compact+retry once, then a clear actionable error --
{
  let n = 0; globalThis.fetch = async () => { n++; return tooLarge(); };
  const engine = new Engine({ apiKey: "test", cwd: process.cwd(), systemPrompt: "t", models: [primary], session: createSession(process.cwd(), primary.id, "ask"), skills: [] });
  const c = cb();
  await engine.run("go", c.cb);
  const sys = c.systems;
  ok("no fallback: compacted + retried once", sys.some((s) => /compact/i.test(s) && /retry/i.test(s)));
  ok("no fallback: clear error names the limit", sys.some((s) => /too large/i.test(s) && /TPM|token/i.test(s)));
  ok("no fallback: error suggests /compact or /clear", sys.some((s) => /\/compact/.test(s) || /\/clear/.test(s)));
  ok("no fallback: active model unchanged", engine.modelId === primary.id);
  ok("413 never triggers a backoff retry (2 attempts: original + post-compact)", n === 2);
}

// --- engine with fallback: compact+retry, then switch to the larger model ----
{
  globalThis.fetch = async (_u, init) => (JSON.parse(init.body).model === primary.id ? tooLarge() : good());
  const engine = new Engine({ apiKey: "test", cwd: process.cwd(), systemPrompt: "t", models: [primary, big], session: createSession(process.cwd(), primary.id, "ask"), skills: [], fallbackModel: big.id });
  const c = cb();
  await engine.run("go", c.cb);
  ok("with fallback: switched to the larger-capacity model", engine.modelId === big.id);
  ok("with fallback: announced the fallback", c.systems.some((s) => /falling back/i.test(s) && s.includes(big.id)));
  ok("with fallback: the turn then completed", engine.messages.some((m) => m.role === "assistant" && m.text === "ok"));
}

try { await fs.rm("C:/Users/Dominique/dom/verify/_fakehome", { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

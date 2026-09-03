// Verify: prompt caching (OpenRouter → Anthropic cache_control). Breakpoints after
// system + tools + last message for cache-capable models; nothing for others;
// cached-token accounting; and an offline mirror of a 5-iteration Sonnet turn
// (cache reads on iterations 2-5). Isolated to a fake home for the engine tests.
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOME = path.join(path.dirname(fileURLToPath(import.meta.url)), "_fakehome");
process.env.USERPROFILE = HOME;
process.env.HOME = process.env.USERPROFILE;

import { promises as fs } from "node:fs";
import { streamCompletion } from "../dist/provider.js";
import { Engine } from "../dist/engine.js";
import { createSession } from "../dist/config.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const sse = (...chunks) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n\n") + "\n\ndata: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } });
const textChunk = (t) => ({ choices: [{ delta: { content: t } }] });
const toolChunk = (n, name, args) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c" + n, function: { name, arguments: JSON.stringify(args) } }] } }] });
const usageChunk = (u) => ({ choices: [{ delta: {} }], usage: u });

const messages = [{ role: "system", content: "SYS" }, { role: "user", content: "hi" }];
const tools = [
  { type: "function", function: { name: "a", description: "", parameters: {} } },
  { type: "function", function: { name: "b", description: "", parameters: {} } },
];
const call = (cache, capture) =>
  streamCompletion(
    { apiKey: "test", model: "anthropic/claude-sonnet-4.6", messages, tools, signal: new AbortController().signal, cache, retry: { baseDelayMs: 1 } },
    () => {},
  );

// --- provider: cache=true injects the three breakpoints ---------------------
{
  let body = null;
  globalThis.fetch = async (_u, init) => { body = JSON.parse(init.body); return sse(textChunk("ok"), usageChunk({ prompt_tokens: 10, completion_tokens: 2, cost: 0, prompt_tokens_details: { cached_tokens: 8 } })); };
  await call(true);
  const sysBlock = Array.isArray(body.messages[0].content) && body.messages[0].content.at(-1);
  const lastMsg = Array.isArray(body.messages[1].content) && body.messages[1].content.at(-1);
  ok("system prompt gets a cache_control breakpoint", sysBlock && sysBlock.cache_control?.type === "ephemeral");
  ok("last message gets a cache_control breakpoint", lastMsg && lastMsg.cache_control?.type === "ephemeral");
  ok("last tool gets a cache_control breakpoint", body.tools[1].cache_control?.type === "ephemeral");
  ok("earlier tool has NO cache_control", body.tools[0].cache_control === undefined);
}

// --- provider: cache=false sends NO cache_control at all --------------------
{
  let body = null;
  globalThis.fetch = async (_u, init) => { body = JSON.parse(init.body); return sse(textChunk("ok"), usageChunk({ prompt_tokens: 10, completion_tokens: 2, cost: 0 })); };
  await call(false);
  ok("cache=false: system content is a plain string", body.messages[0].content === "SYS");
  ok("cache=false: no cache_control anywhere in the request", !JSON.stringify(body).includes("cache_control"));
}

// --- provider: cached-token accounting from prompt_tokens_details -----------
{
  globalThis.fetch = async () => sse(textChunk("ok"), usageChunk({ prompt_tokens: 100, completion_tokens: 5, cost: 0, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 } }));
  const r = await call(true);
  ok("usage captures cached_tokens (reads)", r.usage.cached_tokens === 80);
  ok("usage captures cache_write_tokens", r.usage.cache_write_tokens === 20);
  ok("usage.prompt_tokens is the full input count", r.usage.prompt_tokens === 100);
}

// --- engine: a 5-iteration turn on a caching model (Sonnet-like) ------------
const caching = { id: "anthropic/claude-sonnet-4.6", name: "Sonnet", context_length: 200000, pricing: { prompt: 0.000003, completion: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 }, supported_parameters: ["tools"] };
const plain = { id: "deepseek/deepseek-chat", name: "DeepSeek", context_length: 64000, pricing: { prompt: 0.0000002, completion: 0.000001, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"] };
const cb = { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult() {}, onSystem() {}, async requestPermission() { return "no"; } };
const lastMarked = (b) => Array.isArray(b.messages.at(-1).content) && b.messages.at(-1).content.at(-1).cache_control?.type === "ephemeral";

{
  const bodies = []; let n = 0;
  globalThis.fetch = async (_u, init) => {
    n++; bodies.push(JSON.parse(init.body));
    const u = { prompt_tokens: 1000, completion_tokens: 10, cost: 0, prompt_tokens_details: { cached_tokens: n >= 2 ? 100 : 0 } }; // reads on iters 2-5
    return n < 5
      ? sse(toolChunk(n, "glob", { pattern: "zzzz-none-match-*.xyz" }), usageChunk(u)) // read-only tool, no prompt
      : sse(textChunk("done"), usageChunk(u));
  };
  const engine = new Engine({ apiKey: "test", cwd: process.cwd(), systemPrompt: "SYS", models: [caching, plain], session: createSession(process.cwd(), caching.id, "ask"), skills: [] });
  await engine.run("go", cb);

  ok("the turn ran 5 iterations", bodies.length === 5);
  ok("cache_control is sent on every iteration (caching model)", bodies.every((b) => JSON.stringify(b).includes("cache_control")));
  ok("the last-message breakpoint moves forward as history grows", bodies[4].messages.length > bodies[0].messages.length && bodies.every(lastMarked));
  ok("cache reads accumulate over iterations 2-5 (4 × 100)", engine.cost.cachedPromptTokens === 400);
  // /cost math: cached vs uncached split of the input tokens.
  const cached = engine.cost.cachedPromptTokens;
  const uncached = engine.cost.promptTokens - cached;
  ok("/cost splits input: cached + uncached = total (400 cached / 4600 uncached)", cached === 400 && uncached === 4600 && cached + uncached === engine.cost.promptTokens);
}

// --- engine: a non-caching model still works and sends no cache_control -----
{
  let body = null;
  globalThis.fetch = async (_u, init) => { body = JSON.parse(init.body); return sse(textChunk("hi"), usageChunk({ prompt_tokens: 50, completion_tokens: 2, cost: 0 })); };
  const engine = new Engine({ apiKey: "test", cwd: process.cwd(), systemPrompt: "SYS", models: [caching, plain], session: createSession(process.cwd(), plain.id, "ask"), skills: [] });
  await engine.run("go", cb);
  ok("non-caching model sends NO cache_control", !JSON.stringify(body).includes("cache_control"));
  ok("non-caching model completes the turn", engine.messages.some((m) => m.role === "assistant" && m.text === "hi"));
  ok("non-caching model records 0 cached tokens", (engine.cost.cachedPromptTokens ?? 0) === 0);
}

try { await fs.rm(HOME, { recursive: true, force: true }); } catch {}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

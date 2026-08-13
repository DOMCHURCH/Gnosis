// Verify 1d: a 429 retries with backoff and then succeeds; non-retryable fails fast.
import { streamCompletion, ProviderError } from "../dist/provider.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "✓" : "✗"} ${name}`); if (!cond) fails++; };

const sse = [
  'data: {"choices":[{"delta":{"content":"ok"}}]}',
  '',
  'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":1,"cost":0}}',
  '',
  'data: [DONE]',
  '',
].join("\n");

const good = () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
const rateLimited = () =>
  new Response("Rate limit reached. Please try again in 0.01s", { status: 429, headers: { "retry-after": "0" } });

const call = (opts) =>
  streamCompletion(
    {
      apiKey: "test",
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      signal: new AbortController().signal,
      retry: { baseDelayMs: 1, maxRetries: 4 },
      ...opts,
    },
    () => {},
  );

// --- 429 twice, then 200: should retry and succeed ---
{
  let n = 0;
  globalThis.fetch = async () => { n++; return n <= 2 ? rateLimited() : good(); };
  const res = await call();
  ok("429×2 then 200 → succeeds with body 'ok'", res.text === "ok");
  ok("429×2 then 200 → made 3 fetch attempts (2 retries)", n === 3);
}

// --- the specific Groq '1.8s' hint parses without throwing ---
{
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    return n === 1
      ? new Response("Please try again in 1.8s", { status: 429 }) // no retry-after header; body hint used
      : good();
  };
  const res = await call({ retry: { baseDelayMs: 1, maxRetries: 4 } });
  ok("Groq 'try again in 1.8s' body hint → retries and succeeds", res.text === "ok" && n === 2);
}

// --- non-retryable 400: fail fast, no retries ---
{
  let n = 0;
  globalThis.fetch = async () => { n++; return new Response("bad request", { status: 400 }); };
  let threw = null;
  try { await call(); } catch (e) { threw = e; }
  ok("400 → throws ProviderError", threw instanceof ProviderError);
  ok("400 → only 1 attempt (no retry)", n === 1);
}

// --- persistent 429 beyond maxRetries: eventually throws ---
{
  let n = 0;
  globalThis.fetch = async () => { n++; return rateLimited(); };
  let threw = null;
  try { await call({ retry: { baseDelayMs: 1, maxRetries: 2 } }); } catch (e) { threw = e; }
  ok("persistent 429 → throws after exhausting retries", threw instanceof ProviderError);
  ok("persistent 429 → attempts = maxRetries + 1 (3)", n === 3);
}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

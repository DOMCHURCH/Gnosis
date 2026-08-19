// Verify (feature 6 — web search): web_search queries Brave, returns title/URL/
// snippet for the top results (HTML stripped), reads BRAVE_API_KEY from ~/.dom/.env,
// and errors clearly (naming the variable + where to get a key) when it's missing.
// Error statuses and empty results are handled; the tool is excluded from plan mode.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { runWebSearch } = await import("../dist/tools/websearch.js");
const { Engine } = await import("../dist/engine.js");
const { createSession } = await import("../dist/config.js");

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

// --- 1) no key set → clear, actionable error --------------------------------
{
  globalThis.fetch = async () => { throw new Error("fetch must not be called without a key"); };
  const r = await runWebSearch({ query: "anything" });
  ok("no key → error names BRAVE_API_KEY", r.isError && /BRAVE_API_KEY/.test(r.output));
  ok("...names the .env file and where to get a key", r.output.includes(".env") && /brave\.com\/search\/api/.test(r.output));
}

// --- set the key, then mock the Brave endpoint ------------------------------
await fs.mkdir(path.join(fake, ".dom"), { recursive: true });
await fs.writeFile(path.join(fake, ".dom", ".env"), "BRAVE_API_KEY=testkey\n");

let braveMode = "ok";
let lastReq = null;
globalThis.fetch = async (url, opts) => {
  lastReq = { url: String(url), headers: opts?.headers ?? {} };
  if (braveMode === "401") return new Response("bad key", { status: 401 });
  if (braveMode === "429") return new Response("slow down", { status: 429 });
  if (braveMode === "empty") return new Response(JSON.stringify({ web: { results: [] } }), { status: 200, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({
    web: {
      results: [
        { title: "First <strong>Result</strong>", url: "https://example.com/1", description: "A <b>snippet</b> about things &amp; stuff." },
        { title: "Second", url: "https://example.com/2", description: "Second snippet." },
        { title: "Third", url: "https://example.com/3", description: "Third." },
      ],
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
};

// --- 2) success: title/URL/snippet, HTML stripped, headers/encoding ---------
{
  braveMode = "ok";
  const r = await runWebSearch({ query: "test query" });
  ok("returns each result's title, URL, and snippet", !r.isError && r.output.includes("First Result") && r.output.includes("https://example.com/1") && r.output.includes("snippet about things & stuff"));
  ok("HTML tags are stripped from title + snippet", !/<strong>|<b>/.test(r.output));
  ok("sends the Brave subscription-token header", lastReq.headers["X-Subscription-Token"] === "testkey");
  ok("URL-encodes the query", lastReq.url.includes("q=test%20query"));
  ok("defaults to count=8", lastReq.url.includes("count=8"));
}

// --- 3) count clamping ------------------------------------------------------
{
  await runWebSearch({ query: "x", count: 100 });
  ok("count is capped at 20", lastReq.url.includes("count=20"));
  await runWebSearch({ query: "x", count: 1 });
  ok("count honors a small explicit value", lastReq.url.includes("count=1"));
}

// --- 4) error statuses ------------------------------------------------------
{
  braveMode = "401";
  const r = await runWebSearch({ query: "x" });
  ok("401 → key-rejected error pointing at the .env file", r.isError && /rejected the API key/.test(r.output) && r.output.includes(".env"));
  braveMode = "429";
  const r2 = await runWebSearch({ query: "x" });
  ok("429 → rate-limit message", r2.isError && /rate limited/.test(r2.output));
}

// --- 5) empty results → friendly, non-error ---------------------------------
{
  braveMode = "empty";
  const r = await runWebSearch({ query: "nothing here at all" });
  ok("no results → friendly message, not an error", !r.isError && /No results/.test(r.output));
}

// --- 6) excluded from plan mode, present in ask mode ------------------------
{
  const model = { id: "m", name: "M", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"], input_modalities: ["text"] };
  const eng = new Engine({ apiKey: "k", cwd: fake, systemPrompt: "t", models: [model], session: createSession(fake, "m", "plan"), skills: [], autoCommit: false });
  ok("web_search is NOT available in plan mode", !eng.availableToolNames().includes("web_search"));
  eng.setMode("ask");
  ok("web_search IS available in ask mode", eng.availableToolNames().includes("web_search"));
}

try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

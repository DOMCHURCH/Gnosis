// Verify: the OpenRouter provider preference actually reaches the wire.
//
// Most models are served by several providers at the same price and very
// different speeds, and OpenRouter's default order is not the fastest. Voice
// turns made that measurable: 27k prompt tokens and a two-sentence answer took
// 3.5s of pure model round trip, at roughly 10-15 tokens/sec. `provider.sort`
// is how we ask for the quick one, and it is a single line that a refactor can
// drop without breaking a single response — so it is asserted here rather than
// noticed later in a timing log.
// Its own throwaway home: the Groq case needs a groqApiKey in config, and
// writing one into the shared _fakehome would hand it to every other suite.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
const HOME = "C:/Users/Dominique/dom/verify/_fakehome-s107";
rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME + "/.dom", { recursive: true });
writeFileSync(HOME + "/.dom/config.json", JSON.stringify({ groqApiKey: "gsk_test" }));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

import { streamCompletion } from "../dist/provider.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const sse = (...chunks) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n\n") + "\n\ndata: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } });
const usageChunk = { choices: [{ delta: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0 } };

const messages = [{ role: "system", content: "SYS" }, { role: "user", content: "hi" }];

/** Run one completion and hand back the body that went over the wire. */
async function wire(opts) {
  let body = null;
  globalThis.fetch = async (_u, init) => { body = JSON.parse(init.body); return sse(usageChunk); };
  await streamCompletion(
    { apiKey: "test", messages, tools: [], signal: new AbortController().signal, retry: { baseDelayMs: 1 }, ...opts },
    () => {},
  );
  return body;
}

{
  const body = await wire({ model: "deepseek/deepseek-v4-flash", routing: "throughput" });
  ok("throughput routing reaches the request body", body.provider?.sort === "throughput");
}

{
  const body = await wire({ model: "deepseek/deepseek-v4-flash", routing: "price" });
  // The knob has to be a knob: a run that cares about the bill more than the
  // wait sets this, and silently sending "throughput" anyway would spend money
  // the user asked us not to.
  ok("price routing is honoured, not overridden", body.provider?.sort === "price");
}

{
  // Absent means absent. Sending a sort nobody asked for changes which provider
  // serves every request, and that is not a default to apply from in here.
  const body = await wire({ model: "deepseek/deepseek-v4-flash" });
  ok("no preference sends no provider block", body.provider === undefined);
}

{
  // Groq and OpenAI are reached directly, and neither knows what `provider`
  // means — an unknown key is a 400 waiting to happen on a route that has only
  // one provider by definition.
  const body = await wire({ model: "groq/llama-3.3-70b-versatile", routing: "throughput" });
  ok("a direct (non-OpenRouter) route sends no provider block", body.provider === undefined);
}

console.log(fails ? `\n${fails} FAILED` : "\nall provider-routing checks passed");
rmSync(HOME, { recursive: true, force: true });
process.exit(fails ? 1 : 0);

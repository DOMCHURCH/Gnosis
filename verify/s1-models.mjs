// Verify 1a: :batch filtering + exact-first model resolution.
import { isChatModelId, resolveModelQuery } from "../dist/models.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "✓" : "✗"} ${name}`); if (!cond) fails++; };

// --- :batch filtering (what parse()/fetchModels apply to the live catalog) ---
ok(":batch id is not a chat model", isChatModelId("anthropic/claude-sonnet-4.6:batch") === false);
ok("plain id is a chat model", isChatModelId("anthropic/claude-sonnet-4.6") === true);
ok(":free variant is still chat-capable", isChatModelId("meta/llama:free") === true);

// A raw catalog as returned by the provider, including a :batch variant.
const raw = [
  { id: "anthropic/claude-sonnet-4.6", name: "Anthropic: Claude Sonnet 4.6" },
  { id: "anthropic/claude-sonnet-4.6:batch", name: "Anthropic: Claude Sonnet 4.6 (batch)" },
  { id: "anthropic/claude-opus-4.8", name: "Anthropic: Claude Opus 4.8" },
  { id: "openai/gpt-4o-mini", name: "OpenAI: GPT-4o mini" },
  { id: "deepseek/deepseek-chat", name: "DeepSeek Chat" },
].map((m) => ({ ...m, pricing: { prompt: 0, completion: 0 }, context_length: 0, supported_parameters: ["tools"] }));

// The catalog the app actually resolves against has :batch removed (parse() drops it).
const catalog = raw.filter((m) => isChatModelId(m.id));
ok("filtered catalog excludes the :batch id", !catalog.some((m) => m.id.includes(":batch")));

// --- /model sonnet resolves to the non-batch id ---
const sonnet = resolveModelQuery(catalog, "sonnet");
ok("'sonnet' → matches (opens picker)", sonnet.kind === "matches");
ok("'sonnet' includes the non-batch id", sonnet.ids?.includes("anthropic/claude-sonnet-4.6"));
ok("'sonnet' NEVER includes a :batch id", !sonnet.ids?.some((id) => id.includes(":batch")));

// Even if a :batch id somehow survived, substring 'sonnet' would surface it —
// proving the real defense is filtering it OUT of the catalog first.
const unfiltered = resolveModelQuery(raw, "sonnet");
ok("(control) unfiltered catalog WOULD leak :batch on substring", unfiltered.ids?.some((id) => id.includes(":batch")));

// --- exact-first preference ---
const baseExact = resolveModelQuery(catalog, "claude-sonnet-4.6");
ok("'claude-sonnet-4.6' → basename match to full id", baseExact.kind === "matches" && baseExact.ids.length === 1 && baseExact.ids[0] === "anthropic/claude-sonnet-4.6");

const full = resolveModelQuery(catalog, "anthropic/claude-sonnet-4.6");
ok("full id → exact (switches immediately, no picker)", full.kind === "exact" && full.id === "anthropic/claude-sonnet-4.6");

const none = resolveModelQuery(catalog, "nonexistent-xyz");
ok("no match → none", none.kind === "none");

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

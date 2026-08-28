// Model catalog. OpenRouter's /models endpoint is public; Groq's needs the key.
// Both providers are fetched (concurrently) and merged; Groq models are tagged
// "groq/<id>". Cached per-provider in memory; on total failure we degrade to a
// small built-in list so model switching still works.

import { loadConfig } from "./config.js";

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";
const GROQ_PREFIX = "groq/";

// Used when the live catalog can't be reached. All verified live + tool-capable
// against the OpenRouter catalog (Aug 2026); no retired ids.
const FALLBACK_IDS = [
  "google/gemini-2.5-flash-lite",
  "anthropic/claude-sonnet-4.6",
  "deepseek/deepseek-chat",
  "openai/gpt-4o-mini",
];

export interface ModelEntry {
  id: string;
  name: string;
  /** USD per token (OpenRouter reports these as strings; parsed to numbers here).
   * cacheRead/cacheWrite are the prompt-cache prices; a non-zero cacheWrite means
   * the provider accepts explicit cache_control breakpoints (Anthropic, Gemini). */
  pricing: { prompt: number; completion: number; cacheRead: number; cacheWrite: number };
  context_length: number;
  /** True only when the provider actually published prices. Groq's /models does
   * not, and the offline fallback list has none — without this flag their zeroed
   * pricing is indistinguishable from a genuinely free model, and the picker
   * would advertise a paid model as free. */
  pricingKnown?: boolean;
  /** OpenRouter capability flags; a tool-capable model includes "tools". */
  supported_parameters: string[];
  /** Accepted input types from architecture.input_modalities; a vision model
   * includes "image". Defaults to ["text"] when the catalog doesn't say. */
  input_modalities: string[];
}

// A few of the built-in fallback models are vision-capable; tag them so
// view_image / @image still work offline when the live catalog is unreachable.
const VISION_FALLBACK = new Set([
  "google/gemini-2.5-flash-lite",
  "anthropic/claude-sonnet-4.6",
  "openai/gpt-4o-mini",
]);

function toNum(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// OpenRouter exposes variant suffixes (":free", ":nitro", ":batch", ...). Most
// serve the standard /chat/completions path; ":batch" is the exception — it only
// works through the async Batch API and 404s here with "only available through
// the Batch API". Exclude those variants from the catalog entirely so /model can
// never resolve to one.
const NON_CHAT_SUFFIXES = [":batch"];

/** True unless the id names a variant that isn't served by chat/completions. */
export function isChatModelId(id: string): boolean {
  const lower = id.toLowerCase();
  return !NON_CHAT_SUFFIXES.some((s) => lower.endsWith(s));
}

function parse(raw: unknown): ModelEntry[] {
  const data = (raw as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return [];
  const out: ModelEntry[] = [];
  for (const m of data as any[]) {
    if (!m || typeof m.id !== "string") continue;
    // Skip variants that don't serve the standard completions path (e.g. :batch).
    if (!isChatModelId(m.id)) continue;
    const supported: string[] = Array.isArray(m.supported_parameters)
      ? m.supported_parameters.map(String)
      : [];
    // Only tool-capable models are usable by the agent.
    if (!supported.includes("tools")) continue;
    const inputModalities: string[] = Array.isArray(m.architecture?.input_modalities)
      ? m.architecture.input_modalities.map(String)
      : ["text"];
    out.push({
      id: m.id,
      name: typeof m.name === "string" ? m.name : m.id,
      pricing: {
        prompt: toNum(m.pricing?.prompt),
        completion: toNum(m.pricing?.completion),
        cacheRead: toNum(m.pricing?.input_cache_read),
        cacheWrite: toNum(m.pricing?.input_cache_write),
      },
      context_length: toNum(m.context_length ?? m.top_provider?.context_length),
      pricingKnown: true,
      supported_parameters: supported,
      input_modalities: inputModalities,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// Groq's /models is OpenAI-style and exposes neither pricing nor capability
// flags, so we surface every model (tagged groq/<id>) — the list is small.
function parseGroq(raw: unknown): ModelEntry[] {
  const data = (raw as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return [];
  const out: ModelEntry[] = [];
  for (const m of data as any[]) {
    if (!m || typeof m.id !== "string") continue;
    out.push({
      id: `${GROQ_PREFIX}${m.id}`,
      name: m.id,
      pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 },
      context_length: toNum(m.context_window ?? m.context_length),
      supported_parameters: ["tools"],
      input_modalities: ["text"], // Groq's /models exposes no modality flags
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function fallback(): ModelEntry[] {
  return FALLBACK_IDS.map((id) => ({
    id,
    name: id,
    pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 },
    context_length: 0,
    supported_parameters: ["tools"],
    input_modalities: VISION_FALLBACK.has(id) ? ["text", "image"] : ["text"],
  }));
}

// Each provider is memoised independently, so a transient failure of one is
// retried on the next call without discarding the other's results.
let orCache: ModelEntry[] | null = null;
let groqCache: ModelEntry[] | null = null;

async function fetchOpenRouterModels(force: boolean): Promise<ModelEntry[]> {
  if (orCache && !force) return orCache;
  try {
    const res = await fetch(MODELS_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const models = parse(await res.json());
    if (models.length) {
      orCache = models;
      return models;
    }
  } catch {
    /* offline — fall through to empty */
  }
  return [];
}

async function fetchGroqModels(force: boolean): Promise<ModelEntry[]> {
  if (groqCache && !force) return groqCache;
  const cfg = await loadConfig();
  if (!cfg.groqApiKey) return []; // Groq disabled — never fetch without a key
  try {
    const res = await fetch(GROQ_MODELS_URL, {
      headers: { Authorization: `Bearer ${cfg.groqApiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const models = parseGroq(await res.json());
    if (models.length) {
      groqCache = models;
      return models;
    }
  } catch {
    /* unreachable or bad key — fall through to empty */
  }
  return [];
}

/**
 * Return the merged model catalog (OpenRouter + Groq when a groqApiKey is set).
 * `force` bypasses the per-provider caches. Never throws — if both providers
 * yield nothing it returns the built-in fallback list.
 */
/** True when the catalog says this model accepts image input. */
export function isVisionModel(m: ModelEntry): boolean {
  return m.input_modalities.includes("image");
}

/**
 * The cheapest vision-capable model in the catalog, or null if it has none.
 *
 * Suggested to the user whenever they hit the "this model can't see images" wall,
 * INSTEAD of naming a model in a string somewhere: a hardcoded suggestion is wrong
 * the moment the catalog moves — the id gets retired, or something cheaper ships —
 * and it silently recommends a model the user may not even have access to.
 *
 * Ranked on prompt price (that is what an image costs you), then completion price,
 * then id so the choice is stable across calls rather than depending on catalog
 * ordering. A zero prompt price is a free variant and legitimately ranks first.
 */
export function cheapestVisionModel(models: ModelEntry[]): ModelEntry | null {
  const vision = models.filter(isVisionModel);
  if (!vision.length) return null;
  return vision.slice().sort((a, b) =>
    a.pricing.prompt - b.pricing.prompt ||
    a.pricing.completion - b.pricing.completion ||
    a.id.localeCompare(b.id),
  )[0]!;
}

/**
 * One line telling the user how to get vision, naming the cheapest model the live
 * catalog actually offers. Falls back to the generic advice if the catalog can't
 * be reached, so this never blocks on the network.
 */
export async function suggestVisionModel(): Promise<string> {
  try {
    const pick = cheapestVisionModel(await fetchModels());
    if (!pick) return "Switch to a vision model with /model.";
    const usd = pick.pricing.prompt * 1e6;
    const price = usd > 0 ? ` (cheapest vision model in the catalog, $${usd.toFixed(2)}/M input tokens)` : " (free vision model in the catalog)";
    return `Switch to a vision model with \`/model ${pick.id}\`${price}.`;
  } catch {
    return "Switch to a vision model with /model.";
  }
}

export async function fetchModels(force = false): Promise<ModelEntry[]> {
  const [openRouter, groq] = await Promise.all([fetchOpenRouterModels(force), fetchGroqModels(force)]);
  const merged = [...openRouter, ...groq];
  return merged.length ? merged : fallback();
}

// ---------------------------------------------------------------------------
// /model argument resolution
// ---------------------------------------------------------------------------

export type ModelResolution =
  | { kind: "exact"; id: string }
  | { kind: "matches"; ids: string[] }
  | { kind: "none" };

/** The id after its provider prefix, e.g. "anthropic/claude-sonnet-4.6" → "claude-sonnet-4.6". */
function basename(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}

/**
 * Resolve a `/model <arg>` argument to a model id, preferring the most specific
 * match. Tiers, best first: exact full id, exact basename (provider prefix
 * dropped), prefix, then substring. An exact full id is applied directly; every
 * other tier returns candidate ids so the caller can confirm the full resolved
 * id in the picker before switching. Never resolves to a non-chat (:batch) id —
 * those are already absent from the catalog.
 */
/** `/model` arguments, split into the flag and the model query. */
export interface ModelCommand {
  /** `--save` / `-s` seen anywhere in the arguments. */
  save: boolean;
  /** Everything that was not a flag — the model id or search query ("" for none). */
  model: string;
}

/**
 * Parse `/model` arguments. Order-independent by construction: the flag is found
 * by scanning every token rather than by looking at a fixed position, so
 * `--save <id>` and `<id> --save` behave identically.
 *
 * Positional parsing was the bug: it only recognised a LEADING flag, so
 * `/model deepseek/deepseek-v4-flash --save` folded "--save" into the model
 * query and matched nothing. A model id never begins with "-", which is what
 * makes dropping flag tokens safe.
 */
export function parseModelCommand(arg: string): ModelCommand {
  const toks = (arg ?? "").trim().split(/\s+/).filter(Boolean);
  const isFlag = (t: string) => t === "--save" || t === "-s";
  return {
    save: toks.some(isFlag),
    // Remaining tokens re-joined, so a multi-word search ("claude sonnet") survives.
    model: toks.filter((t) => !isFlag(t)).join(" "),
  };
}

export function resolveModelQuery(models: ModelEntry[], query: string): ModelResolution {
  const q = query.trim().toLowerCase();
  if (!q) return { kind: "none" };
  const ids = models.map((m) => m.id);

  const exact = ids.find((id) => id.toLowerCase() === q);
  if (exact) return { kind: "exact", id: exact };

  const baseExact = ids.filter((id) => basename(id).toLowerCase() === q);
  if (baseExact.length) return { kind: "matches", ids: baseExact };

  const prefix = ids.filter(
    (id) => id.toLowerCase().startsWith(q) || basename(id).toLowerCase().startsWith(q),
  );
  if (prefix.length) return { kind: "matches", ids: prefix };

  const sub = models
    .filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
    .map((m) => m.id);
  if (sub.length) return { kind: "matches", ids: sub };

  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// Price presentation (shared by the TUI picker and the browser overlay)
// ---------------------------------------------------------------------------

/**
 * A model's tier for the picker.
 *   free    — the provider publishes a price and it is zero (":free" variants)
 *   paid    — the provider publishes a non-zero price
 *   unknown — the provider publishes no prices at all (Groq, offline fallback)
 *
 * The unknown tier exists so a Groq model, whose pricing this catalog zero-fills
 * because Groq's /models never reports it, is not advertised as free.
 */
export type ModelTier = "free" | "paid" | "unknown";

export function modelTier(m: ModelEntry): ModelTier {
  if (!m.pricingKnown) return "unknown";
  return m.pricing.prompt === 0 && m.pricing.completion === 0 ? "free" : "paid";
}

export function isFreeModel(m: ModelEntry): boolean {
  return modelTier(m) === "free";
}

/** Per-1M-token USD, trimmed: sub-cent prices keep enough digits to stay distinct. */
function per1M(n: number): string {
  const v = n * 1e6;
  if (v === 0) return "0";
  if (v < 0.01) return v.toFixed(4).replace(/0+$/, "");
  if (v < 1) return v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return v.toFixed(2);
}

/**
 * The price line shown next to a model in every picker: "$3/$15 per 1M in/out",
 * "free", or "price n/a". One function so the TUI and the browser can never drift
 * into quoting different numbers for the same model.
 */
export function priceLabel(m: ModelEntry): string {
  const tier = modelTier(m);
  if (tier === "unknown") return "price n/a";
  if (tier === "free") return "free";
  return `$${per1M(m.pricing.prompt)}/$${per1M(m.pricing.completion)} per 1M in/out`;
}

/** Context window as a short "200K" / "1M" token count, or "" when unknown. */
export function contextLabel(m: ModelEntry): string {
  const n = m.context_length;
  if (!n) return "";
  if (n >= 1e6) return `${+(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M ctx`;
  if (n >= 1000) return `${Math.round(n / 1000)}K ctx`;
  return `${n} ctx`;
}

/** The full right-hand hint for a picker row: price, then context window. */
export function modelHint(m: ModelEntry): string {
  const ctx = contextLabel(m);
  return ctx ? `${priceLabel(m)} · ${ctx}` : priceLabel(m);
}

/** One picker row for a model. Shaped to satisfy the TUI's PickItem, and carried
 * verbatim over `overlay.open` to the browser overlay. */
export interface ModelPickItem {
  value: string;
  label: string;
  hint: string;
  tier: ModelTier;
  search: string;
}

/**
 * The model picker's rows, built ONCE for both surfaces. The TUI and the headless
 * serve host each used to assemble their own list, which is how the browser ended
 * up showing bare model ids while the terminal showed prices — the browser's list
 * simply never had a price in it.
 */
export function buildModelPickItems(models: ModelEntry[]): ModelPickItem[] {
  return models.map((m) => ({
    value: m.id,
    label: m.id,
    hint: modelHint(m),
    tier: modelTier(m),
    // Typing in either picker narrows by id, name, or tier ("free" / "paid").
    search: `${m.id} ${m.name} ${modelTier(m)}`,
  }));
}

/**
 * The price note appended to a "switched to <id>" line.
 *
 * A ":free" id already says it is free, so repeating the word produced
 * "switched to minimax/minimax-m3:free  free". Paid models always quote the
 * price — that is the number worth confirming at the moment you switch.
 */
export function switchPriceNote(m: ModelEntry | undefined | null): string {
  if (!m) return "";
  const tier = modelTier(m);
  if (tier === "unknown") return "  price n/a";
  if (tier === "free") return /:free$/i.test(m.id) ? "" : "  free";
  return `  ${priceLabel(m)}`;
}

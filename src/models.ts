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
  /** USD per token (OpenRouter reports these as strings; parsed to numbers here). */
  pricing: { prompt: number; completion: number };
  context_length: number;
  /** OpenRouter capability flags; a tool-capable model includes "tools". */
  supported_parameters: string[];
}

function toNum(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parse(raw: unknown): ModelEntry[] {
  const data = (raw as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return [];
  const out: ModelEntry[] = [];
  for (const m of data as any[]) {
    if (!m || typeof m.id !== "string") continue;
    const supported: string[] = Array.isArray(m.supported_parameters)
      ? m.supported_parameters.map(String)
      : [];
    // Only tool-capable models are usable by the agent.
    if (!supported.includes("tools")) continue;
    out.push({
      id: m.id,
      name: typeof m.name === "string" ? m.name : m.id,
      pricing: {
        prompt: toNum(m.pricing?.prompt),
        completion: toNum(m.pricing?.completion),
      },
      context_length: toNum(m.context_length ?? m.top_provider?.context_length),
      supported_parameters: supported,
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
      pricing: { prompt: 0, completion: 0 },
      context_length: toNum(m.context_window ?? m.context_length),
      supported_parameters: ["tools"],
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function fallback(): ModelEntry[] {
  return FALLBACK_IDS.map((id) => ({
    id,
    name: id,
    pricing: { prompt: 0, completion: 0 },
    context_length: 0,
    supported_parameters: ["tools"],
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
export async function fetchModels(force = false): Promise<ModelEntry[]> {
  const [openRouter, groq] = await Promise.all([fetchOpenRouterModels(force), fetchGroqModels(force)]);
  const merged = [...openRouter, ...groq];
  return merged.length ? merged : fallback();
}

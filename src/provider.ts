// Provider layer (OpenAI-compatible). No SDK — plain fetch + SSE.
// Default is OpenRouter; models prefixed "groq/" route natively to Groq.

import { loadConfig } from "./config.js";
import type { ToolCall, WireMessage } from "./messages.js";

const BASE = "https://openrouter.ai/api/v1";
const GROQ_BASE = "https://api.groq.com/openai/v1";
export const GROQ_PREFIX = "groq/";
const ATTRIBUTION = {
  "HTTP-Referer": "https://github.com/DOMCHURCH/Gnosis",
  "X-Title": "Gnosis",
};

interface Route {
  url: string;
  apiKey: string;
  /** Provider-side model id (the "groq/" prefix stripped for Groq). */
  model: string;
  /** Label used in error messages. */
  label: string;
  isOpenRouter: boolean;
}

/**
 * Pick the endpoint + key for a model id. "groq/..." routes to Groq using the
 * configured groqApiKey (erroring clearly if unset); everything else uses the
 * OpenRouter path unchanged with the supplied key.
 */
async function resolveRoute(model: string, openRouterKey: string): Promise<Route> {
  if (model.startsWith(GROQ_PREFIX)) {
    const cfg = await loadConfig();
    if (!cfg.groqApiKey) {
      throw new ProviderError(
        `Model ${model} needs a Groq API key. Add { "groqApiKey": "gsk_..." } to ~/.dom/config.json.`,
      );
    }
    return {
      url: `${GROQ_BASE}/chat/completions`,
      apiKey: cfg.groqApiKey,
      model: model.slice(GROQ_PREFIX.length),
      label: "Groq",
      isOpenRouter: false,
    };
  }
  return { url: `${BASE}/chat/completions`, apiKey: openRouterKey, model, label: "OpenRouter", isOpenRouter: true };
}

export interface ModelInfo {
  id: string;
  name: string;
  context_length: number;
  /** USD per token. cacheWrite > 0 means the provider supports explicit
   * cache_control breakpoints (Anthropic/Gemini via OpenRouter). */
  pricing: { prompt: number; completion: number; cacheRead: number; cacheWrite: number };
  supported_parameters: string[];
  /** Accepted input types; a vision model includes "image". */
  input_modalities: string[];
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  /** Of prompt_tokens, how many were served from cache (read) vs written to it. */
  cached_tokens: number;
  cache_write_tokens: number;
  /** OpenRouter's computed dollar cost for the request, when usage.include is set. */
  cost: number;
}

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
}

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

// ---------------------------------------------------------------------------
// Streaming chat completion
// ---------------------------------------------------------------------------

interface ToolCallAccumulator {
  id?: string;
  name?: string;
  args: string;
}

export class ProviderError extends Error {}

/**
 * A provider failure that will NOT clear by retrying the same model: a 404 (model
 * gone / not on this account) or an upstream/shared-pool 429 (the limit is the
 * provider's, not our account's). The engine catches this to switch to the
 * configured fallback model rather than backing off in place forever.
 */
export class FallbackNeededError extends ProviderError {
  constructor(
    message: string,
    readonly status: number,
    readonly upstream: boolean,
  ) {
    super(message);
  }
}

/**
 * The request exceeded the model's size / tokens-per-minute limit (HTTP 413).
 * Retrying is pointless — the body won't shrink — so the engine compacts and, if
 * still too large, falls back to a larger-capacity model instead of backing off.
 */
export class TooLargeError extends ProviderError {
  constructor(message: string, readonly detail: string) {
    super(message);
  }
}

/**
 * Is this 429 attributable to the UPSTREAM provider / a shared free pool rather
 * than our own account? OpenRouter names it in the error body as
 * `limit_source: "upstream_provider_shared_pool"`. Only these get a fallback —
 * our own rate limit clears on backoff, so it's retried in place.
 */
function isUpstreamRateLimit(body: string): boolean {
  const m = body.match(/"limit_source"\s*:\s*"([^"]+)"/i);
  return m ? /upstream|shared[\s_-]*pool/i.test(m[1]!) : false;
}

// HTTP statuses worth retrying IN PLACE: our-own rate limiting and transient
// gateway/server errors. A 429 in particular must not kill the turn — we back off
// and retry. (An *upstream* 429 or a 404 is handled separately, via fallback.)
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const MAX_BACKOFF_MS = 30_000;

/** setTimeout as an awaitable that rejects (AbortError) if the turn is aborted
 * mid-wait, so Ctrl+C during a backoff still ends the turn promptly. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** How long to wait before retrying, from Retry-After (seconds or HTTP-date) or
 * a provider hint in the body (Groq: "Please try again in 1.8s"); null if none. */
function parseRetryDelay(retryAfter: string | null, body: string): number | null {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const when = Date.parse(retryAfter);
    if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  }
  const m = body.match(/try again in\s+([\d.]+)\s*s/i);
  if (m) return Math.ceil(parseFloat(m[1]!) * 1000);
  return null;
}

// --- prompt caching (OpenRouter → Anthropic cache_control) ------------------

const EPHEMERAL = { type: "ephemeral" } as const;
type CacheBlock = { type: "text"; text: string; cache_control: typeof EPHEMERAL };

/**
 * Add cache_control breakpoints that OpenRouter forwards to Anthropic: after the
 * tool definitions (last tool), after the system prompt (last system message),
 * and on the last message — which moves forward each turn as history grows.
 * Anthropic caches the prefix [tools, system, messages] up to each breakpoint, so
 * within a multi-step turn iterations 2+ read the growing prefix. Called ONLY for
 * models that support it; a non-caching model gets the untouched wire format with
 * no cache_control anywhere. Stays within Anthropic's 4-breakpoint limit (3 used).
 */
function withCacheBreakpoints(
  messages: WireMessage[],
  tools: ToolSchema[],
): { messages: unknown[]; tools: unknown[] } {
  const lastSystem = messages.reduce((acc, m, i) => (m.role === "system" ? i : acc), -1);
  const last = messages.length - 1;
  const outMessages = messages.map((m, i) => {
    if ((i === lastSystem || i === last) && typeof m.content === "string" && m.content.length > 0) {
      const content: CacheBlock[] = [{ type: "text", text: m.content, cache_control: EPHEMERAL }];
      return { ...m, content };
    }
    return m;
  });
  const outTools = tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: EPHEMERAL } : t));
  return { messages: outMessages, tools: outTools };
}

/**
 * Stream a chat completion. Text deltas are delivered via `onText` as they
 * arrive. Tool-call fragments are accumulated by index and their argument
 * strings concatenated before returning. `usage` is read from the final chunk.
 */
export async function streamCompletion(
  opts: {
    apiKey: string;
    model: string;
    messages: WireMessage[];
    tools: ToolSchema[];
    signal: AbortSignal;
    /** Apply cache_control breakpoints (only for cache-capable models). */
    cache?: boolean;
    /** Backoff tuning (defaults: 4 retries, 500ms base). Overridable for tests. */
    retry?: { maxRetries?: number; baseDelayMs?: number };
  },
  onText: (delta: string) => void,
): Promise<CompletionResult> {
  const route = await resolveRoute(opts.model, opts.apiKey);

  // cache_control is an OpenRouter→Anthropic feature; only apply for a cache-capable
  // model on the OpenRouter route, and never send it to Groq.
  const useCache = !!opts.cache && route.isOpenRouter;
  const wire = useCache
    ? withCacheBreakpoints(opts.messages, opts.tools)
    : { messages: opts.messages as unknown[], tools: opts.tools as unknown[] };

  const body: Record<string, unknown> = {
    model: route.model,
    messages: wire.messages,
    tools: wire.tools.length ? wire.tools : undefined,
    tool_choice: opts.tools.length ? "auto" : undefined,
    stream: true,
  };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${route.apiKey}`,
    "Content-Type": "application/json",
  };
  if (route.isOpenRouter) {
    body.usage = { include: true }; // OpenRouter reports dollar cost in the final chunk
    Object.assign(headers, ATTRIBUTION);
  } else {
    body.stream_options = { include_usage: true }; // OpenAI/Groq token usage in the final chunk
  }

  const payload = JSON.stringify(body);
  const maxRetries = opts.retry?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = opts.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  // Our-own 429 and transient 5xx are retried in place with exponential backoff +
  // jitter (honouring a provider-suggested delay). A 404 or an *upstream* 429 won't
  // clear by retrying the same model, so it's thrown as FallbackNeededError for the
  // engine to switch models. The request body is idempotent across attempts.
  let res: Response;
  let lastDetail = "";
  for (let attempt = 0; ; attempt++) {
    res = await fetch(route.url, { method: "POST", headers, body: payload, signal: opts.signal });
    if (res.ok) break;

    lastDetail = await res.text().catch(() => ""); // read the error body once, to classify

    if (res.status === 413) {
      // Too large for the model's limit — retrying sends the same bytes. The engine
      // compacts / falls back instead.
      throw new TooLargeError(`${route.label} 413: request too large`, lastDetail);
    }
    if (res.status === 404) {
      throw new FallbackNeededError(`${route.label} 404: model "${route.model}" not found`, 404, false);
    }
    if (res.status === 429 && isUpstreamRateLimit(lastDetail)) {
      throw new FallbackNeededError(`${route.label} 429: upstream provider rate limit (shared pool)`, 429, true);
    }

    if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
      const suggested = parseRetryDelay(res.headers.get("retry-after"), lastDetail);
      const backoff = Math.min(suggested ?? baseDelayMs * 2 ** attempt, MAX_BACKOFF_MS);
      await sleep(backoff + Math.floor(Math.random() * 250), opts.signal);
      continue;
    }
    break; // non-retryable, or retries exhausted
  }

  if (!res.ok || !res.body) {
    throw new ProviderError(`${route.label} ${res.status}: ${lastDetail.slice(0, 500)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let text = "";
  const toolAcc = new Map<number, ToolCallAccumulator>();
  let usage: Usage = { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, cache_write_tokens: 0, cost: 0 };

  const handleData = (payload: string) => {
    if (payload === "[DONE]") return;
    let chunk: any;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return; // ignore unparseable keep-alive noise
    }
    if (chunk.usage) {
      // Cached input tokens: OpenRouter normalizes Anthropic's cache_read/creation
      // into OpenAI-style prompt_tokens_details (cached_tokens = reads).
      const details = chunk.usage.prompt_tokens_details ?? {};
      usage = {
        prompt_tokens: Number(chunk.usage.prompt_tokens ?? 0) || 0,
        completion_tokens: Number(chunk.usage.completion_tokens ?? 0) || 0,
        cached_tokens: Number(details.cached_tokens ?? 0) || 0,
        cache_write_tokens: Number(details.cache_write_tokens ?? details.cache_creation_tokens ?? 0) || 0,
        cost: Number(chunk.usage.cost ?? 0) || 0,
      };
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta;
    if (!delta) return;
    if (typeof delta.content === "string" && delta.content.length) {
      text += delta.content;
      onText(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = Number(tc.index ?? 0);
        const acc = toolAcc.get(idx) ?? { args: "" };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (typeof tc.function?.arguments === "string") acc.args += tc.function.arguments;
        toolAcc.set(idx, acc);
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (!line || line.startsWith(":")) continue; // blank or comment
      if (!line.startsWith("data:")) continue;
      handleData(line.slice(5).trim());
    }
  }

  const toolCalls: ToolCall[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, acc]) => ({
      id: acc.id || `call_${idx}`,
      name: acc.name || "",
      args: acc.args || "",
    }))
    .filter((c) => c.name.length > 0);

  return { text, toolCalls, usage };
}

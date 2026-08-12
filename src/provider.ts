// Provider layer (OpenAI-compatible). No SDK — plain fetch + SSE.
// Default is OpenRouter; models prefixed "groq/" route natively to Groq.

import { loadConfig } from "./config.js";
import type { ToolCall, WireMessage } from "./messages.js";

const BASE = "https://openrouter.ai/api/v1";
const GROQ_BASE = "https://api.groq.com/openai/v1";
export const GROQ_PREFIX = "groq/";
const ATTRIBUTION = {
  "HTTP-Referer": "https://github.com/dom-agent/dom",
  "X-Title": "dom",
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
  /** USD per token. */
  pricing: { prompt: number; completion: number };
  supported_parameters: string[];
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
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
  },
  onText: (delta: string) => void,
): Promise<CompletionResult> {
  const route = await resolveRoute(opts.model, opts.apiKey);

  const body: Record<string, unknown> = {
    model: route.model,
    messages: opts.messages,
    tools: opts.tools.length ? opts.tools : undefined,
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

  const res = await fetch(route.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new ProviderError(`${route.label} ${res.status}: ${detail.slice(0, 500)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let text = "";
  const toolAcc = new Map<number, ToolCallAccumulator>();
  let usage: Usage = { prompt_tokens: 0, completion_tokens: 0, cost: 0 };

  const handleData = (payload: string) => {
    if (payload === "[DONE]") return;
    let chunk: any;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return; // ignore unparseable keep-alive noise
    }
    if (chunk.usage) {
      usage = {
        prompt_tokens: Number(chunk.usage.prompt_tokens ?? 0) || 0,
        completion_tokens: Number(chunk.usage.completion_tokens ?? 0) || 0,
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

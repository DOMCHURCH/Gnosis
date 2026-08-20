// Provider-neutral message store.
//
// History is stored in this internal shape and serialized to OpenAI wire format
// at request time. We NEVER store raw API payloads — that is what makes switching
// models mid-session safe (models disagree on tool-call formatting, and some
// reject histories containing another model's malformed call blocks).

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments string, exactly as assembled from the stream. */
  args: string;
}

/** An image attached to a user message (view_image tool, or an @image in input). */
export interface ImagePart {
  /** Original path (or source label) — shown to the user, used as a fallback note. */
  source: string;
  /** MIME type, e.g. "image/png". */
  mime: string;
  /** Base64-encoded image bytes (no data: prefix). */
  data: string;
}

export type Msg =
  | { role: "user"; text: string; images?: ImagePart[] }
  | { role: "assistant"; text?: string; calls?: ToolCall[] }
  | { role: "tool"; callId: string; name: string; result: string; isError: boolean };

/** An OpenAI content part: plain text, or an image referenced by a data URL. */
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/** A wire message in OpenAI chat-completions format. */
export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
  name?: string;
}

/**
 * Serialize internal history to OpenAI wire format. `system` is the system
 * prompt; `summary` is an optional compaction note injected as a second system
 * message. `opts.images` gates whether attached images are emitted as image_url
 * content blocks — false (the current model can't view images) degrades them to a
 * text note so the request stays valid across a runtime model switch.
 */
export function serialize(
  messages: Msg[],
  system: string,
  summary?: string | null,
  opts?: { images?: boolean },
): WireMessage[] {
  const wire: WireMessage[] = [{ role: "system", content: system }];
  if (summary) {
    wire.push({ role: "system", content: `[Earlier conversation summary]\n${summary}` });
  }
  for (const m of messages) {
    if (m.role === "user") {
      if (m.images?.length && opts?.images) {
        const parts: ContentPart[] = [];
        if (m.text) parts.push({ type: "text", text: m.text });
        for (const img of m.images) parts.push({ type: "image_url", image_url: { url: `data:${img.mime};base64,${img.data}` } });
        wire.push({ role: "user", content: parts });
      } else if (m.images?.length) {
        // The active model can't view images — keep the turn but note them.
        const note = `[${m.images.length} image(s) not shown — the current model can't view images: ${m.images.map((i) => i.source).join(", ")}]`;
        wire.push({ role: "user", content: m.text ? `${m.text}\n${note}` : note });
      } else {
        wire.push({ role: "user", content: m.text });
      }
    } else if (m.role === "assistant") {
      const wm: WireMessage = { role: "assistant", content: m.text ?? null };
      if (m.calls && m.calls.length > 0) {
        wm.tool_calls = m.calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.args || "{}" },
        }));
      }
      wire.push(wm);
    } else {
      // tool result
      wire.push({
        role: "tool",
        tool_call_id: m.callId,
        name: m.name,
        content: m.result,
      });
    }
  }
  return wire;
}

export interface ContextCategory {
  name: string;
  tokens: number;
}

/**
 * Break the context window's usage down by category (system prompt, summary, user
 * messages, assistant text, tool calls, tool results, images) with the same ~4
 * chars/token estimate the context meter uses. Drives the /context readout.
 */
export function contextBreakdown(messages: Msg[], system: string, summary: string | null): ContextCategory[] {
  const est = (s: string) => Math.ceil(s.length / 4);
  let user = 0;
  let assistantText = 0;
  let toolArgs = 0;
  let toolResults = 0;
  let images = 0;
  for (const m of messages) {
    if (m.role === "user") {
      user += est(m.text);
      images += (m.images?.length ?? 0) * 1000; // rough per-image estimate (matches estimateTokens)
    } else if (m.role === "assistant") {
      assistantText += est(m.text ?? "");
      for (const c of m.calls ?? []) toolArgs += est(c.name + c.args);
    } else {
      toolResults += est(m.result) + est(m.name);
    }
  }
  return [
    { name: "system prompt", tokens: est(system) },
    { name: "summary", tokens: summary ? est(summary) : 0 },
    { name: "user messages", tokens: user },
    { name: "assistant text", tokens: assistantText },
    { name: "tool calls", tokens: toolArgs },
    { name: "tool results", tokens: toolResults },
    { name: "images", tokens: images },
  ].filter((c) => c.tokens > 0);
}

/** Cheap token estimate (~4 chars per token) used for the context meter and compaction trigger. */
export function estimateTokens(messages: Msg[], system = ""): number {
  let chars = system.length;
  for (const m of messages) {
    if (m.role === "user") {
      chars += m.text.length;
      // Rough flat cost per attached image so the context meter isn't way off.
      chars += (m.images?.length ?? 0) * 4000;
    } else if (m.role === "assistant") {
      chars += (m.text ?? "").length;
      for (const c of m.calls ?? []) chars += c.name.length + c.args.length;
    } else {
      chars += m.result.length + m.name.length;
    }
    chars += 8; // per-message framing overhead
  }
  return Math.ceil(chars / 4);
}

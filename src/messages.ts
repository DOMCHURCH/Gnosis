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

export type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string; calls?: ToolCall[] }
  | { role: "tool"; callId: string; name: string; result: string; isError: boolean };

/** A wire message in OpenAI chat-completions format. */
export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
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
 * message.
 */
export function serialize(messages: Msg[], system: string, summary?: string | null): WireMessage[] {
  const wire: WireMessage[] = [{ role: "system", content: system }];
  if (summary) {
    wire.push({ role: "system", content: `[Earlier conversation summary]\n${summary}` });
  }
  for (const m of messages) {
    if (m.role === "user") {
      wire.push({ role: "user", content: m.text });
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

/** Cheap token estimate (~4 chars per token) used for the context meter and compaction trigger. */
export function estimateTokens(messages: Msg[], system = ""): number {
  let chars = system.length;
  for (const m of messages) {
    if (m.role === "user") chars += m.text.length;
    else if (m.role === "assistant") {
      chars += (m.text ?? "").length;
      for (const c of m.calls ?? []) chars += c.name.length + c.args.length;
    } else {
      chars += m.result.length + m.name.length;
    }
    chars += 8; // per-message framing overhead
  }
  return Math.ceil(chars / 4);
}

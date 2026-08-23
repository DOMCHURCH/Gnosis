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

/** A document (e.g. a PDF) attached to a user message. Rides as an OpenRouter
 * `file` content block; gated on the model accepting document input. */
export interface FilePart {
  /** Original filename / source label — shown to the user, used as a fallback note. */
  source: string;
  /** MIME type, e.g. "application/pdf". */
  mime: string;
  /** Base64-encoded file bytes (no data: prefix). */
  data: string;
}

/** A raw attachment as it arrives from a web client: base64 bytes + declared MIME.
 * partitionAttachments sorts these into images, documents, and inlined text. */
export interface Attachment {
  name: string;
  mime: string;
  /** Base64-encoded bytes (no data: prefix). */
  data: string;
}

export type Msg =
  | { role: "user"; text: string; images?: ImagePart[]; files?: FilePart[] }
  | { role: "assistant"; text?: string; calls?: ToolCall[] }
  | { role: "tool"; callId: string; name: string; result: string; isError: boolean };

/** An OpenAI/OpenRouter content part: plain text, an image (data URL), or a
 * document file (base64 data URL under `file.file_data`, the OpenRouter PDF form). */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

/**
 * Split web-client attachments into image parts, document (file) parts, and text
 * to inline into the message. Images and PDFs ride as content blocks; everything
 * else is decoded from base64 and inlined as text, labeled by filename.
 */
export function partitionAttachments(atts: Attachment[]): { images: ImagePart[]; files: FilePart[]; inlineText: string } {
  const images: ImagePart[] = [];
  const files: FilePart[] = [];
  const texts: string[] = [];
  for (const a of atts) {
    if (a.mime.startsWith("image/")) images.push({ source: a.name, mime: a.mime, data: a.data });
    else if (a.mime === "application/pdf") files.push({ source: a.name, mime: a.mime, data: a.data });
    else {
      let text = "";
      try {
        text = Buffer.from(a.data, "base64").toString("utf8");
      } catch {
        /* undecodable — inline as empty with just the label */
      }
      texts.push(`--- ${a.name} ---\n${text}`);
    }
  }
  return { images, files, inlineText: texts.join("\n\n") };
}

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
 * message. `opts.images` / `opts.documents` gate whether attached images and
 * documents are emitted as content blocks — false (the current model can't accept
 * that modality) degrades them to a text note so the request stays valid across a
 * runtime model switch.
 */
export function serialize(
  messages: Msg[],
  system: string,
  summary?: string | null,
  opts?: { images?: boolean; documents?: boolean },
): WireMessage[] {
  const wire: WireMessage[] = [{ role: "system", content: system }];
  if (summary) {
    wire.push({ role: "system", content: `[Earlier conversation summary]\n${summary}` });
  }
  for (const m of messages) {
    if (m.role === "user") {
      const imgs = m.images ?? [];
      const files = m.files ?? [];
      const showImgs = imgs.length > 0 && !!opts?.images;
      const showFiles = files.length > 0 && !!opts?.documents;
      // Attachments the active model can't accept degrade to a text note so the
      // turn stays valid (and legible) after a runtime model switch.
      const notes: string[] = [];
      if (imgs.length > 0 && !opts?.images) notes.push(`[${imgs.length} image(s) not shown — the current model can't view images: ${imgs.map((i) => i.source).join(", ")}]`);
      if (files.length > 0 && !opts?.documents) notes.push(`[${files.length} file(s) not shown — the current model can't read documents: ${files.map((f) => f.source).join(", ")}]`);
      const withNotes = notes.length ? (m.text ? `${m.text}\n${notes.join("\n")}` : notes.join("\n")) : m.text;
      if (showImgs || showFiles) {
        const parts: ContentPart[] = [];
        if (withNotes) parts.push({ type: "text", text: withNotes });
        if (showImgs) for (const img of imgs) parts.push({ type: "image_url", image_url: { url: `data:${img.mime};base64,${img.data}` } });
        if (showFiles) for (const f of files) parts.push({ type: "file", file: { filename: f.source, file_data: `data:${f.mime};base64,${f.data}` } });
        wire.push({ role: "user", content: parts });
      } else if (notes.length) {
        wire.push({ role: "user", content: withNotes });
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
      // Rough per-attachment estimate (matches estimateTokens); documents counted alongside images.
      images += ((m.images?.length ?? 0) + (m.files?.length ?? 0)) * 1000;
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
      // Rough flat cost per attachment (image or document) so the meter isn't way off.
      chars += ((m.images?.length ?? 0) + (m.files?.length ?? 0)) * 4000;
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

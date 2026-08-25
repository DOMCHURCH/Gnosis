import { fileOutputFor } from "./filekind.js";
// Group a tab's raw chat lines into message blocks — PURE logic, shared by the
// browser renderer and the Node verify run. Consecutive lines from the same
// speaker within the same turn (epoch) collapse into ONE block instead of one
// bubble per line, so a multi-line reply or code block reads as a single message.
//
// Code fences (the TUI's ─── rule boundaries) arrive as rule lines that toggle a
// per-block code segment; the enclosed lines are kept verbatim so the renderer can
// show them monospace in a bordered block rather than reflowing them as prose.
//
// Inputs are RawLine objects already filtered to one tab (see store.ts):
//   { key, from, kind, epoch, time, text?, rule?: "open"|"close", lang?, permId? }
// where kind is "user" | "assistant" | "system" | "approval".

// Replace the pending approval card for `id` with its outcome, in place among the
// raw lines: mark it resolved and rewrite the text to "approved: …" / "denied: …".
// Shared by the store (on permission.resolved) so the render + logic can't drift.
export function resolveApproval(lines, id, answer) {
  const verb = answer === "no" ? "denied" : "approved";
  return lines.map((l) =>
    l.kind === "approval" && l.permId === id && !l.resolved
      ? { ...l, resolved: answer, text: `${verb}: ${l.label ?? (l.text || "").replace(/^Needs approval:\s*/, "")}` }
      : l,
  );
}

export function groupChat(lines) {
  const groups = [];
  let cur = null;

  const open = (ln, kind) => {
    cur = { key: ln.key, from: ln.from, time: ln.time, kind: kind || ln.kind, epoch: ln.epoch, segments: [], code: false, isApproval: false, permId: undefined };
    groups.push(cur);
    return cur;
  };
  const appendText = (text) => {
    const seg = cur.segments[cur.segments.length - 1];
    if (cur.code && seg && seg.type === "code") seg.text += (seg.text ? "\n" : "") + text;
    else if (!cur.code && seg && seg.type === "text") seg.text += "\n" + text;
    else cur.segments.push({ type: cur.code ? "code" : "text", lang: seg && cur.code ? seg.lang : undefined, text });
  };

  for (const ln of lines) {
    // Approvals are always their own sealed block (buttons while pending; the
    // outcome once resolved).
    if (ln.kind === "approval") {
      groups.push({ key: ln.key, from: ln.from, time: ln.time, kind: "approval", epoch: ln.epoch, segments: [{ type: "text", text: ln.text || "" }], code: false, isApproval: true, permId: ln.permId, resolved: ln.resolved, dreamId: ln.dreamId });
      cur = null;
      continue;
    }
    // The post-turn outcome verdict: one dim line, with a fix-it affordance when
    // it failed.
    if (ln.kind === "outcome") {
      groups.push({ key: ln.key, from: ln.from, time: ln.time, kind: "outcome", epoch: ln.epoch, segments: [{ type: "text", text: ln.text || "" }], code: false, isApproval: false, verdict: ln.verdict, confidence: ln.confidence });
      cur = null;
      continue;
    }
    // An ask_user question is its own sealed block: the question, its option
    // buttons while unanswered, and the reply once it has one.
    if (ln.kind === "ask") {
      groups.push({ key: ln.key, from: ln.from, time: ln.time, kind: "ask", epoch: ln.epoch, segments: [{ type: "text", text: ln.question || "" }], code: false, isApproval: false, askId: ln.askId, options: ln.options || [], answered: ln.answered, dreamId: ln.dreamId });
      cur = null;
      continue;
    }
    // Tool calls are their own sealed block (compact line, expandable to detail).
    if (ln.kind === "tool") {
      // A successful write/edit of a recognised type also carries a fileOutput
      // descriptor, which the rail renders richly under the tool line.
      const fileOutput = ln.ok ? fileOutputFor(ln.tool, ln.primary, `${ln.summary || ""} ${ln.detail || ""}`) : null;
      groups.push({ key: ln.key, from: ln.from, time: ln.time, kind: "tool", epoch: ln.epoch, segments: [], code: false, isApproval: false, fileOutput, tool: { tool: ln.tool, primary: ln.primary, secondary: ln.secondary, ok: ln.ok, summary: ln.summary, detail: ln.detail } });
      cur = null;
      continue;
    }
    // A fence boundary toggles code mode inside the current (assistant) block.
    if (ln.rule) {
      if (!cur || cur.isApproval) open(ln, "assistant");
      if (ln.rule === "open") { cur.code = true; cur.segments.push({ type: "code", lang: ln.lang || "", text: "" }); }
      else cur.code = false;
      continue;
    }
    const isUser = ln.kind === "user";
    const joinable = cur && !cur.isApproval && !isUser && cur.from === ln.from && cur.kind === ln.kind && cur.epoch === ln.epoch;
    if (!joinable) open(ln);
    appendText(ln.text || "");
    if (isUser) cur = null; // a user message is a single sealed block
  }

  return groups
    .map((g) => ({ ...g, segments: g.segments.filter((s) => !(s.type === "code" && s.text === "")) }))
    // Keep tool + approval blocks (no text segments); drop empty text/code blocks.
    .filter((g) => g.kind === "tool" || g.isApproval || g.segments.some((s) => s.type === "code" || s.text.trim() !== ""))
    // NOTE: this projection is an explicit whitelist — a field added to a group
    // above but forgotten here is silently dropped before it ever reaches the
    // rail. Every per-kind payload must be listed.
    .map((g) => ({
      key: g.key, from: g.from, time: g.time, kind: g.kind,
      isApproval: g.isApproval, permId: g.permId, resolved: g.resolved,
      tool: g.tool,
      fileOutput: g.fileOutput,
      askId: g.askId, options: g.options, answered: g.answered,
      dreamId: g.dreamId,
      verdict: g.verdict, confidence: g.confidence,
      segments: g.segments.map((s) => ({ type: s.type, lang: s.lang, text: s.text })),
    }));
}

// --- chat rail visual hierarchy ---------------------------------------------
// Every message type gets its own treatment so a long conversation is scannable
// without reading a word: tool calls sit inset behind a left rule, assistant text
// is full-width and unboxed, system notes read as dim centred captions, user turns
// are anchored to the right by a cyan edge, and permission prompts carry an amber
// wash so they catch the eye while scrolling. Pure so the Node verify covers it.
export const CHAT_HIERARCHY = {
  toolRule: "#3A3A4A",
  toolBg: "#15151C",
  systemDim: "#6B6B7B",
  userEdge: "#22D3EE33",
  approvalTint: "#FBBF2422",
  askEdge: "#E879F9",
};

/**
 * The presentation descriptor for one chat message.
 *   variant     — which of the five treatments applies
 *   bg          — the message body background ("transparent" for unboxed kinds)
 *   borderLeft / borderRight — CSS border shorthands, "" for none
 *   boxed       — whether the body keeps its 2px outline
 *   fontSize    — relative size in em (1 = the rail's base size)
 *   color       — the text colour, or "" to inherit the rail default
 *   centered    — render as a centred caption rather than a left-aligned message
 *   wrapTint    — a full-width tint painted behind the whole message ("" for none)
 *   showMeta    — whether the from/time header row is shown
 */
export function messageStyle(kind, isApproval) {
  if (isApproval) {
    return { variant: "approval", bg: "#101017", borderLeft: "", borderRight: "", boxed: true, fontSize: 1, color: "", centered: false, wrapTint: CHAT_HIERARCHY.approvalTint, showMeta: true };
  }
  // A question is the one thing in the rail that blocks progress, so it gets the
  // strongest treatment after an approval: boxed, tinted, in the ask accent.
  // The outcome verdict reads as machinery, not conversation: dim, small, centred,
  // green on pass and red on fail.
  if (kind === "outcome") {
    return { variant: "outcome", bg: "transparent", borderLeft: "", borderRight: "", boxed: false, fontSize: 0.85, color: CHAT_HIERARCHY.systemDim, centered: true, wrapTint: "", showMeta: false };
  }
  if (kind === "ask") {
    return { variant: "ask", bg: "#101017", borderLeft: `2px solid ${CHAT_HIERARCHY.askEdge}`, borderRight: "", boxed: true, fontSize: 1, color: "", centered: false, wrapTint: "", showMeta: true };
  }
  if (kind === "tool") {
    return { variant: "tool", bg: CHAT_HIERARCHY.toolBg, borderLeft: `2px solid ${CHAT_HIERARCHY.toolRule}`, borderRight: "", boxed: false, fontSize: 0.9, color: "", centered: false, wrapTint: "", showMeta: false };
  }
  if (kind === "system") {
    return { variant: "system", bg: "transparent", borderLeft: "", borderRight: "", boxed: false, fontSize: 0.85, color: CHAT_HIERARCHY.systemDim, centered: true, wrapTint: "", showMeta: false };
  }
  if (kind === "user") {
    return { variant: "user", bg: "#101017", borderLeft: "", borderRight: `2px solid ${CHAT_HIERARCHY.userEdge}`, boxed: true, fontSize: 1, color: "", centered: false, wrapTint: "", showMeta: true };
  }
  // assistant (and anything unrecognised): full width, no box, no background.
  return { variant: "assistant", bg: "transparent", borderLeft: "", borderRight: "", boxed: false, fontSize: 1, color: "", centered: false, wrapTint: "", showMeta: true };
}

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
    // Approvals are always their own sealed block (they carry action buttons).
    if (ln.kind === "approval") {
      groups.push({ key: ln.key, from: ln.from, time: ln.time, kind: "approval", epoch: ln.epoch, segments: [{ type: "text", text: ln.text || "" }], code: false, isApproval: true, permId: ln.permId });
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
    .filter((g) => g.segments.some((s) => s.type === "code" || s.text.trim() !== ""))
    .map((g) => ({ key: g.key, from: g.from, time: g.time, kind: g.kind, isApproval: g.isApproval, permId: g.permId, segments: g.segments.map((s) => ({ type: s.type, lang: s.lang, text: s.text })) }));
}

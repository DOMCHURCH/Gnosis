// Pure kanban classification for the KANBAN view. Sessions fall into four columns:
// ACTIVE, PARKED, REVIEW, DONE. REVIEW is authoritative from the backend (plan mode
// is read-only); PARKED/ACTIVE are a client-only override the user sets by dragging;
// DONE is never stored — dropping a card there closes the session. Kept as plain JS
// (like sessions.js) so the browser and the Node verify run identical code.

export const COLUMNS = ["active", "parked", "review", "done"];
export const COLUMN_LABEL = { active: "ACTIVE", parked: "PARKED", review: "REVIEW", done: "DONE" };
export const COLUMN_COLOR = { active: "#22D3EE", parked: "#FBBF24", review: "#818CF8", done: "#4ADE80" };

/**
 * The effective column for a tab. Plan mode always shows as REVIEW (it IS the
 * read-only review state); otherwise the client override decides PARKED vs ACTIVE.
 * "done" is transient (it closes the session) so it's never a resting column.
 */
export function columnFor(agent, override) {
  if (!agent) return "active";
  if (agent.mode === "plan") return "review";
  if (override === "parked") return "parked";
  return "active";
}

/** The last assistant message for a tab, collapsed + truncated — the card's task. */
export function lastAssistant(chatLines, tabId, max = 80) {
  for (let i = chatLines.length - 1; i >= 0; i--) {
    const l = chatLines[i];
    if (l.tabId === tabId && l.kind === "assistant" && l.text) {
      const t = l.text.trim().replace(/\s+/g, " ");
      return t.length > max ? t.slice(0, max - 1) + "…" : t;
    }
  }
  return "";
}

/** Group the session order into the four columns, honoring per-tab overrides. */
export function boardColumns(state, overrides) {
  const cols = { active: [], parked: [], review: [], done: [] };
  for (const id of state.order || []) {
    const col = columnFor(state.agents[id], (overrides || {})[id]);
    (cols[col] || cols.active).push(id);
  }
  return cols;
}

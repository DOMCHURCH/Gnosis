// Pure per-agent telemetry, folded from the live event stream. Kept as plain JS
// (like sessions.js / chatgroups.js) so the browser bundle and the Node verify run
// identical code. One record per tab: tool call counts (name → ok/fail), turns,
// cumulative + per-turn tokens (for the sparkline), cached tokens, and the current
// turn's start time (for elapsed). All reducers are pure — `now` is injected so the
// same code is deterministic under test.

const SERIES_CAP = 40;

export function emptyTelemetry() {
  return { tools: {}, turns: 0, tokens: 0, cachedTokens: 0, tokensSeries: [], turnStart: null, ok: 0, fail: 0 };
}

/** Fold one DomEvent into a tab's telemetry record, returning a NEW record. */
export function foldTelemetry(rec, event, now) {
  const t = rec || emptyTelemetry();
  switch (event.type) {
    case "tool.end": {
      const cur = t.tools[event.tool] || { ok: 0, fail: 0 };
      const tools = { ...t.tools, [event.tool]: { ok: cur.ok + (event.ok ? 1 : 0), fail: cur.fail + (event.ok ? 0 : 1) } };
      return { ...t, tools, ok: t.ok + (event.ok ? 1 : 0), fail: t.fail + (event.ok ? 0 : 1) };
    }
    case "turn.start":
      return { ...t, turnStart: now };
    case "turn.end": {
      const tok = Math.max(0, event.tokens || 0);
      return {
        ...t,
        turns: t.turns + 1,
        tokens: t.tokens + tok,
        cachedTokens: t.cachedTokens + Math.max(0, event.cachedTokens || 0),
        tokensSeries: [...t.tokensSeries, tok].slice(-SERIES_CAP),
        turnStart: null,
      };
    }
    default:
      return t;
  }
}

/** Total tool calls + success rate (0..1, or null before any calls). */
export function toolStats(rec) {
  const t = rec || emptyTelemetry();
  const total = t.ok + t.fail;
  return { total, ok: t.ok, fail: t.fail, successRate: total ? t.ok / total : null };
}

/** Tool counts as a list [{name, ok, fail, count}], busiest first. */
export function toolList(rec) {
  const t = rec || emptyTelemetry();
  return Object.entries(t.tools)
    .map(([name, c]) => ({ name, ok: c.ok, fail: c.fail, count: c.ok + c.fail }))
    .sort((a, b) => b.count - a.count);
}

const BARS = "▁▂▃▄▅▆▇█";
/** Render a numeric series as a unicode block sparkline (matches the terminal look). */
export function sparkline(series) {
  if (!series || series.length === 0) return "";
  const max = Math.max(...series);
  if (max <= 0) return BARS[0].repeat(series.length);
  return series.map((v) => BARS[Math.min(BARS.length - 1, Math.max(0, Math.round((v / max) * (BARS.length - 1))))]).join("");
}

/** Human elapsed since `turnStart` (ms), "" when idle. e.g. "4s", "1m 12s". */
export function elapsedLabel(turnStart, now) {
  if (turnStart == null) return "";
  const s = Math.max(0, Math.floor((now - turnStart) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

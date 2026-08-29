// The activity feed: what the agent has actually been doing, as a timestamped
// list.
//
// The source is the tool entries already flowing through the chat transcript —
// there is no second event stream to subscribe to, and inventing one would let
// the feed and the transcript disagree. Each message already carries the time it
// arrived, so nothing here has to invent a clock either.

import { useMemo } from "react";
import type { ChatMsg } from "./SessionsFloor";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

export interface ActivityEntry {
  key: string;
  at: string;
  /** "Wrote", "Ran", "Read" — the verb, from the tool name. */
  verb: string;
  /** The object of the verb: a path, a command, a query. */
  subject: string;
  ok: boolean;
  tool: string;
}

/** Past tense for the handful of tools worth narrating. Anything else falls
 * back to the tool's own name, which reads fine ("web_search · react hooks"). */
const VERBS: Record<string, string> = {
  write: "Wrote",
  edit: "Updated",
  read: "Read",
  bash: "Ran",
  grep: "Searched",
  glob: "Globbed",
  http: "Fetched",
  web_search: "Searched",
  task: "Delegated",
  todo: "Planned",
  memory: "Remembered",
  office: "Staffed",
  focus_window: "Focused",
};

/**
 * The tool activity in `chat`, newest last, capped to `limit`.
 *
 * Derived rather than accumulated: the transcript is already the record, so
 * recomputing from it cannot drift out of step with what the chat shows, and a
 * cleared or switched session needs no separate reset.
 */
export function useActivity(chat: ChatMsg[], limit = 40): ActivityEntry[] {
  return useMemo(() => {
    const out: ActivityEntry[] = [];
    for (const m of chat) {
      const t = m.tool;
      if (!t) continue;
      out.push({
        key: m.key,
        at: m.time,
        verb: VERBS[t.tool] ?? t.tool,
        subject: t.primary || t.secondary || "",
        ok: t.ok,
        tool: t.tool,
      });
    }
    return out.slice(-limit);
  }, [chat, limit]);
}

/** The vertical feed inside the inspector. Newest last, like the transcript. */
export function ActivityFeed(props: { entries: ActivityEntry[]; live: boolean; onViewAll?: () => void }) {
  const rows = props.entries.slice(-4);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 9, letterSpacing: 2, color: "#6B6B7B" }}>ACTIVITY</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9, letterSpacing: 1.5, color: "#6B6B7B" }}>
          LIVE
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: props.live ? "#4ADE80" : "#4A4A58",
            boxShadow: props.live ? "0 0 8px #4ADE80" : "none" }} />
        </span>
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 10, color: "#4A4A58" }}>nothing yet</div>
      ) : (
        rows.map((e) => (
          <div key={e.key} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 10, lineHeight: 1.9, minWidth: 0 }}>
            <span style={{ color: "#4A4A58", flex: "0 0 auto", fontVariantNumeric: "tabular-nums" }}>{e.at}</span>
            <span style={{ color: "#9AA3B2", flex: "0 0 auto" }}>{e.verb}</span>
            <span style={{ color: "#22D3EE", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
              {e.subject}
            </span>
            {!e.ok && <span style={{ color: "#F87171", flex: "0 0 auto" }}>✕</span>}
            {e.ok && e.tool === "bash" && <span style={{ color: "#4ADE80", flex: "0 0 auto" }}>✓</span>}
          </div>
        ))
      )}
      {props.onViewAll && props.entries.length > rows.length && (
        <button
          type="button"
          onClick={props.onViewAll}
          style={{ marginTop: 6, fontFamily: MONO, fontSize: 10, letterSpacing: 0.5, background: "transparent",
            color: "#22D3EE", border: 0, padding: 0, cursor: "pointer" }}
        >
          View full activity →
        </button>
      )}
    </div>
  );
}

/** The horizontal strip along the bottom of the window. */
export function ActivityStrip(props: { entries: ActivityEntry[]; agent: string; live: boolean; onClear: () => void }) {
  const rows = props.entries.slice(-4);
  return (
    <div
      data-testid="activity-strip"
      style={{
        display: "flex", alignItems: "center", gap: 14, padding: "0 14px", height: 34,
        fontFamily: MONO, fontSize: 10, color: "#6B6B7B", overflow: "hidden", flex: "0 0 auto",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", flex: "0 0 auto",
        background: props.live ? "#4ADE80" : "#4A4A58", boxShadow: props.live ? "0 0 8px #4ADE80" : "none" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 14, flex: "1 1 auto", minWidth: 0, overflow: "hidden" }}>
        {rows.length === 0 ? (
          <span style={{ color: "#4A4A58" }}>no file operations yet</span>
        ) : (
          rows.map((e, i) => (
            <span key={e.key} style={{ display: "flex", alignItems: "center", gap: 8, flex: "0 0 auto", minWidth: 0 }}>
              {i > 0 && <span style={{ color: "#2C2C3E" }}>|</span>}
              <span style={{ color: "#4A4A58", fontVariantNumeric: "tabular-nums" }}>{e.at}</span>
              <span style={{ color: "#9AA3B2" }}>{props.agent}</span>
              <span>{e.verb}</span>
              <span style={{ color: "#22D3EE", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>
                {e.subject}
              </span>
              {e.ok ? null : <span style={{ color: "#F87171" }}>✕</span>}
            </span>
          ))
        )}
      </div>
      <button
        type="button"
        onClick={props.onClear}
        style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 1.5, background: "transparent", color: "#6B6B7B",
          border: 0, cursor: "pointer", flex: "0 0 auto" }}
      >
        CLEAR
      </button>
    </div>
  );
}

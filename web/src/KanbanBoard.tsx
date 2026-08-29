import { useEffect, useState } from "react";
import type { State } from "./store";
import type { KanbanColumn } from "./kanban";
import { COLUMNS, COLUMN_LABEL, COLUMN_COLOR, boardColumns, lastAssistant } from "./kanban.js";
import { floorFigures } from "./sessions.js";
import { elapsedLabel } from "./telemetry.js";
import { GUTTER } from "./layers";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

/**
 * KANBAN view: every session as a card in one of four columns (ACTIVE, PARKED,
 * REVIEW, DONE). Drag a card to move it — REVIEW switches the session into read-only
 * plan mode, DONE closes it (after confirm), ACTIVE/PARKED are UI-only. Cards update
 * live from the same event-bus state the floor uses.
 */
export function KanbanBoard(props: {
  state: State;
  overrides: Record<number, string>;
  onMove: (tabId: number, column: KanbanColumn) => void;
  onOpen: (tabId: number) => void;
}) {
  const { state } = props;
  const cols = boardColumns(state, props.overrides);
  const [dragId, setDragId] = useState<number | null>(null);
  const [over, setOver] = useState<KanbanColumn | null>(null);
  // Tick so "time running" advances while any session is mid-turn.
  const [, setNow] = useState(0);
  const anyBusy = state.order.some((id) => state.telemetry[id]?.turnStart != null);
  useEffect(() => {
    if (!anyBusy) return;
    const iv = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, [anyBusy]);
  const now = Date.now();

  const drop = (col: KanbanColumn) => { if (dragId != null) props.onMove(dragId, col); setDragId(null); setOver(null); };

  return (
    // Same top gutter as the floor view: the fixed view/serve toggle gets its own
    // band instead of landing on the board's header.
    <div style={{ minHeight: "100vh", background: "#0D0D12", color: "#C9C9D6", fontFamily: MONO, padding: `${GUTTER.top}px 24px 24px`, boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, borderBottom: "2px solid #2C2C3E", paddingBottom: 12, marginBottom: 16 }}>
        <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: 4 }}>Gnosis</span>
        <span style={{ fontSize: 11, color: "#6B6B7B", letterSpacing: 2 }}>KANBAN · {state.order.length} SESSIONS</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, alignItems: "start" }}>
        {(COLUMNS as KanbanColumn[]).map((col) => (
          <div
            key={col}
            onDragOver={(e) => { e.preventDefault(); setOver(col); }}
            onDragLeave={() => setOver((o) => (o === col ? null : o))}
            onDrop={() => drop(col)}
            style={{ background: over === col ? "#171721" : "#121219", border: `2px solid ${over === col ? COLUMN_COLOR[col] : "#2C2C3E"}`, minHeight: 220, display: "flex", flexDirection: "column" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 11px", borderBottom: `2px solid #2C2C3E`, borderTop: `3px solid ${COLUMN_COLOR[col]}` }}>
              <span style={{ fontSize: 11, letterSpacing: 2, color: COLUMN_COLOR[col] }}>{COLUMN_LABEL[col]}</span>
              <span style={{ marginLeft: "auto", fontSize: 10, color: "#6B6B7B" }}>{cols[col].length}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 10 }}>
              {cols[col].length === 0 && <div style={{ fontSize: 9, color: "#4A4A58", padding: "6px 2px" }}>{col === "done" ? "drag here to close" : "—"}</div>}
              {cols[col].map((id) => {
                const a = state.agents[id];
                if (!a) return null;
                const task = lastAssistant(state.chatLines, id) || "no output yet";
                const agents = floorFigures(state, id).length;
                const ts = state.telemetry[id]?.turnStart ?? null;
                const running = ts != null ? elapsedLabel(ts, now) : "idle";
                return (
                  <div
                    key={id}
                    draggable
                    onDragStart={() => setDragId(id)}
                    onDragEnd={() => { setDragId(null); setOver(null); }}
                    onClick={() => props.onOpen(id)}
                    title="drag to move · click to open"
                    style={{ background: "#171721", border: "2px solid #2C2C3E", borderLeft: `4px solid ${COLUMN_COLOR[col]}`, padding: 9, cursor: "grab", display: "flex", flexDirection: "column", gap: 5, opacity: dragId === id ? 0.5 : 1 }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 7, height: 7, background: ts != null ? "#22D3EE" : "#6B6B7B", ...(ts != null ? { animation: "domTab 1.4s ease-in-out infinite" } : {}) }} />
                      <span style={{ fontSize: 12, letterSpacing: 1, color: "#C9C9D6", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
                    </div>
                    <div style={{ fontSize: 9, color: "#6B6B7B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={a.cwd}>{a.cwd}</div>
                    <div style={{ fontSize: 10, color: "#8A8A9B", lineHeight: 1.4, maxHeight: 42, overflow: "hidden" }}>{task}</div>
                    <div style={{ display: "flex", gap: 10, fontSize: 9, color: "#6B6B7B", flexWrap: "wrap" }}>
                      <span>{agents} agent{agents === 1 ? "" : "s"}</span>
                      <span>{a.tokens >= 1000 ? `${(a.tokens / 1000).toFixed(1)}k` : a.tokens} tok</span>
                      <span>${(a.cost || 0).toFixed(4)}</span>
                      <span style={{ color: ts != null ? "#22D3EE" : "#4A4A58" }}>{running}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 14, fontSize: 9, letterSpacing: 1, color: "#4A4A58" }}>
        REVIEW → read-only plan mode · DONE → closes the session (with confirm) · drag between columns
      </div>
    </div>
  );
}

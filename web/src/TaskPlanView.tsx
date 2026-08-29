import { useEffect, useState } from "react";
import type { TaskPlan } from "./taskplan";
import { planStatus, statusIcon, statusColor, subtaskElapsed } from "./taskplan.js";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

/**
 * The task execution plan for a coordinated task(): one row per subtask with its
 * description, assigned agent id, live status icon (queued/running/done/failed),
 * and elapsed time. `compact` is the smaller variant that floats over the
 * coordinator desk on the office floor; the default renders in the chat rail.
 */
export function TaskPlanView(props: { plan: TaskPlan; compact?: boolean }) {
  const { plan, compact } = props;
  const st = planStatus(plan);
  // Tick every second while the plan is still running so elapsed clocks advance.
  const [, setNow] = useState(0);
  useEffect(() => {
    if (st.complete) return;
    const iv = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, [st.complete]);
  const now = Date.now();

  const headColor = st.failed > 0 ? "#F87171" : st.complete ? "#4ADE80" : "#22D3EE";
  return (
    <div style={{ border: "2px solid #2C2C3E", background: compact ? "#0D0D12F2" : "#121219", fontFamily: MONO, ...(compact ? { boxShadow: "0 10px 28px rgba(0,0,0,0.6)", width: 236 } : { margin: "0 0 0 0" }) }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: compact ? "5px 8px" : "7px 10px", borderBottom: "1px solid #2C2C3E" }}>
        <span style={{ fontSize: compact ? 8 : 9, letterSpacing: 2, color: "#C084FC" }}>COORDINATED TASK</span>
        <span style={{ marginLeft: "auto", fontSize: compact ? 8 : 9, letterSpacing: 1, color: headColor }}>
          {st.done + st.failed}/{st.total} {st.complete ? "done" : "running"}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", ...(compact ? { maxHeight: 150, overflowY: "auto" } : {}) }}>
        {plan.subtasks.map((s) => (
          <div key={s.index} style={{ display: "flex", alignItems: "center", gap: 7, padding: compact ? "3px 8px" : "5px 10px", borderTop: "1px solid #17171F" }}>
            <span style={{ fontSize: compact ? 11 : 12, color: statusColor(s.status), width: 12, textAlign: "center", ...(s.status === "running" ? { animation: "domBlink 1s steps(1) infinite" } : {}) }}>{statusIcon(s.status)}</span>
            <span style={{ fontSize: 8, color: "#6B6B7B", whiteSpace: "nowrap" }}>#{s.index}</span>
            <span style={{ flex: 1, minWidth: 0, fontSize: compact ? 9 : 10, color: s.status === "queued" ? "#6B6B7B" : "#C9C9D6", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.description}>{s.description}</span>
            <span style={{ fontSize: 8, color: "#4A4A58", whiteSpace: "nowrap" }}>{subtaskElapsed(s, now) || (s.status === "queued" ? "queued" : "")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

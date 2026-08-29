// The agent inspector header: who is working, on what, how far in, and toward
// which goal.
//
// Everything here is derived from state that already exists — the sessions
// model, the task plan, the goal record — so the inspector cannot claim an agent
// is doing something the floor and the transcript disagree about. The chat that
// sits below it in the panel is the existing ChatPanel, unchanged.

import { planStatus } from "./taskplan.js";
import type { TaskPlan } from "./taskplan";
import { MARK_ROWS } from "./logo.generated";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

/** The Gnosis mark, reused as the agent avatar. */
function Avatar({ size = 30 }: { size?: number }) {
  const rows = MARK_ROWS;
  const w = rows[0].length;
  const h = rows.length;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${w + 2} ${h + 2}`} aria-hidden="true" style={{ display: "block", flex: "0 0 auto" }}>
      <defs>
        <radialGradient id="inspectorMark" cx="50%" cy="45%" r="75%">
          <stop offset="0%" stopColor="#2DD9F0" />
          <stop offset="100%" stopColor="#8B1DA8" />
        </radialGradient>
      </defs>
      <rect x="0" y="0" width={w + 2} height={h + 2} rx={(w + 2) * 0.26} fill="url(#inspectorMark)" />
      {rows.flatMap((row, y) =>
        [...row].map((c, x) => (c === "#" ? <rect key={`${x}-${y}`} x={x + 1} y={y + 1} width={1} height={1} fill="#F7FAFF" /> : null)),
      )}
    </svg>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 9, letterSpacing: 2, color: "#6B6B7B", marginBottom: 7 }}>{children}</div>;
}

export function InspectorHeader(props: {
  name: string;
  state: string;
  stateColor: string;
  task: string;
  plan: TaskPlan | null;
  goal: string | null;
  onMinimize?: () => void;
  onClose?: () => void;
}) {
  // Progress comes from the plan's own subtask counts when there is a plan.
  // Without one there is no honest number to show, so the bar is omitted rather
  // than faked at some arbitrary percentage.
  const status = props.plan ? planStatus(props.plan) : null;
  const pct = status && status.total > 0 ? Math.round((status.done / status.total) * 100) : null;

  return (
    <div style={{ padding: "12px 14px 14px", display: "flex", flexDirection: "column", gap: 14, flex: "0 0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontSize: 9, letterSpacing: 2, color: "#6B6B7B" }}>AGENT INSPECTOR</span>
        <span style={{ display: "flex", gap: 10, color: "#4A4A58" }}>
          {props.onMinimize && (
            <button type="button" title="collapse" onClick={props.onMinimize}
              style={{ fontFamily: MONO, fontSize: 12, lineHeight: 1, background: "transparent", color: "inherit", border: 0, cursor: "pointer", padding: 0 }}>—</button>
          )}
          {props.onClose && (
            <button type="button" title="hide" onClick={props.onClose}
              style={{ fontFamily: MONO, fontSize: 12, lineHeight: 1, background: "transparent", color: "inherit", border: 0, cursor: "pointer", padding: 0 }}>✕</button>
          )}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
        <Avatar />
        <span style={{ flex: 1, minWidth: 0, fontSize: 16, fontWeight: 700, letterSpacing: 1, color: "#E6EDF3", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {props.name}
        </span>
        <span
          data-testid="status-badge"
          style={{
            fontSize: 9, letterSpacing: 1.4, textTransform: "uppercase", padding: "4px 10px",
            border: `1px solid ${props.stateColor}55`, color: props.stateColor,
            background: "#12121c", whiteSpace: "nowrap",
          }}
        >
          {props.state}
        </span>
        <span style={{ width: 8, height: 8, borderRadius: "50%", flex: "0 0 auto", background: props.stateColor, boxShadow: `0 0 8px ${props.stateColor}` }} />
      </div>

      <div>
        <Label>CURRENT TASK</Label>
        <div style={{ fontSize: 11, lineHeight: 1.6, color: "#C9D1D9", wordBreak: "break-word" }}>
          {props.task || "nothing running"}
        </div>
        {pct !== null && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
            <div style={{ flex: 1, height: 3, background: "#22222E", overflow: "hidden" }}>
              <div
                data-testid="task-progress"
                style={{
                  width: `${pct}%`, height: "100%",
                  background: "linear-gradient(90deg, #22D3EE, #67E8F9)",
                  transition: "width 300ms ease-out",
                }}
              />
            </div>
            <span style={{ fontSize: 10, color: "#9AA3B2", fontVariantNumeric: "tabular-nums", flex: "0 0 auto" }}>{pct}%</span>
          </div>
        )}
      </div>

      {props.goal && (
        <div>
          <Label>GOAL</Label>
          <div style={{ fontSize: 11, lineHeight: 1.6, color: "#9AA3B2", wordBreak: "break-word" }}>{props.goal}</div>
        </div>
      )}
    </div>
  );
}

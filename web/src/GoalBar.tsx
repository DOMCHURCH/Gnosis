import { useEffect, useState } from "react";
import type { GoalReview, GoalState } from "./types";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

export interface GoalBarProps {
  goal: GoalState | null;
  review: GoalReview | null;
  disabled: boolean;
  onSet: (g: { text: string; maxRounds: number; reviewModel?: string; active: boolean }) => void;
  onClear: () => void;
}

// The goal bar: a standing goal the active agent is held to. After each
// file-touching turn the server runs the read-only reviewer over `git diff HEAD`
// vs this goal (never the conversation); a FAIL steers the agent back to work and
// burns a round. The verdict + rounds-left show here, above the chat rail.
export function GoalBar(props: GoalBarProps) {
  const { goal, review } = props;
  const [text, setText] = useState(goal?.text ?? "");
  const [rounds, setRounds] = useState(String(goal?.maxRounds ?? 3));
  const [reviewModel, setReviewModel] = useState(goal?.reviewModel ?? "");

  // Re-sync the editable fields when the server echoes a new goal state (e.g.
  // another client set it, or the goal was cleared).
  useEffect(() => {
    setText(goal?.text ?? "");
    setRounds(String(goal?.maxRounds ?? 3));
    setReviewModel(goal?.reviewModel ?? "");
  }, [goal?.text, goal?.maxRounds, goal?.reviewModel]);

  const active = goal?.active ?? false;
  const locked = active && !!goal; // a live goal: reviews are running
  const verdict = review?.verdict;
  const badgeColor = verdict === "pass" ? "#4ADE80" : verdict === "fail" ? "#F87171" : "#FBBF24";

  const set = (over?: { active?: boolean }) => {
    const t = text.trim();
    if (!t) return;
    const n = Math.max(1, Math.min(20, Number(rounds) || 3));
    props.onSet({ text: t, maxRounds: n, reviewModel: reviewModel.trim() || undefined, active: over?.active ?? true });
  };
  const toggleLock = () => {
    if (!goal) return set({ active: true });
    props.onSet({ text: goal.text, maxRounds: goal.maxRounds, reviewModel: goal.reviewModel, active: !goal.active });
  };

  const input: React.CSSProperties = { fontFamily: MONO, fontSize: 11, color: "#C9C9D6", background: "#101017", border: "2px solid #2A2A38", padding: "6px 8px", outline: "none" };
  const btn = (bg: string, fg: string): React.CSSProperties => ({ fontFamily: MONO, fontSize: 10, letterSpacing: 1, background: bg, color: fg, border: 0, padding: "6px 12px", cursor: props.disabled ? "not-allowed" : "pointer", opacity: props.disabled ? 0.5 : 1 });

  return (
    <div style={{ background: "#15151C", border: `2px solid ${locked ? "#22D3EE" : "#2A2A38"}`, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: "2px solid #2A2A38" }}>
        <span style={{ fontSize: 9, letterSpacing: 2, color: "#6B6B7B" }}>GOAL</span>
        {goal ? (
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {verdict && <span style={{ fontSize: 9, letterSpacing: 1, color: badgeColor }}>{verdict.toUpperCase()}</span>}
            <span style={{ fontSize: 9, letterSpacing: 1, color: goal.roundsLeft > 0 ? "#C9C9D6" : "#6B6B7B" }}>{goal.roundsLeft}/{goal.maxRounds} ROUNDS</span>
            <span style={{ fontSize: 9, letterSpacing: 1, color: active ? "#4ADE80" : "#6B6B7B" }}>{active ? "● LIVE" : "○ PAUSED"}</span>
          </span>
        ) : (
          <span style={{ fontSize: 9, letterSpacing: 1, color: "#6B6B7B" }}>not set</span>
        )}
      </div>

      <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 7 }}>
        <input
          type="text"
          value={text}
          disabled={props.disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") set(); }}
          placeholder="hold this agent to a goal… (e.g. all tests pass and the endpoint returns 200)"
          style={{ ...input, width: "100%", boxSizing: "border-box" }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
          <label style={{ fontSize: 9, letterSpacing: 1, color: "#6B6B7B" }}>ROUNDS</label>
          <input type="number" min={1} max={20} value={rounds} disabled={props.disabled} onChange={(e) => setRounds(e.target.value)} style={{ ...input, width: 52 }} />
          <input type="text" value={reviewModel} disabled={props.disabled} onChange={(e) => setReviewModel(e.target.value)} placeholder="review model (optional)" style={{ ...input, flex: "1 1 140px", minWidth: 100 }} />
          <button type="button" disabled={props.disabled} onClick={() => set()} style={btn("#22D3EE", "#0D0D12")}>{goal ? "UPDATE" : "SET"}</button>
          {goal && <button type="button" disabled={props.disabled} onClick={toggleLock} style={btn("#101017", "#C9C9D6")}>{active ? "PAUSE" : "RESUME"}</button>}
          {goal && <button type="button" disabled={props.disabled} onClick={props.onClear} style={btn("#101017", "#F87171")}>CLEAR</button>}
        </div>
        {review && verdict !== "pass" && (
          <div style={{ fontSize: 10, lineHeight: 1.5, color: "#C9C9D6", background: "#101017", border: `2px solid ${badgeColor}`, padding: "6px 8px", whiteSpace: "pre-wrap", maxHeight: 96, overflowY: "auto" }}>
            {review.text.split("\n").slice(0, 6).join("\n")}
          </div>
        )}
      </div>
    </div>
  );
}

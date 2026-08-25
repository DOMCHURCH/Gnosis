import { useState } from "react";

/**
 * The `ask_user` reply control in the chat rail: the agent's suggested options as
 * buttons, plus a free-text box that is always present. Options are a shortcut,
 * not a constraint — the useful answer is often "neither, do X instead".
 */
export function AskCard(props: { options: string[]; onAnswer: (text: string) => void }) {
  const [draft, setDraft] = useState("");
  const btn = {
    fontFamily: "inherit", fontSize: 10, letterSpacing: 1, background: "#101017",
    color: "#C9C9D6", border: "2px solid #E879F9", padding: "6px 12px", cursor: "pointer",
  } as const;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {props.options.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {props.options.map((o, i) => (
            <button key={i} type="button" style={btn} onClick={() => props.onAnswer(o)}>{o}</button>
          ))}
        </div>
      )}
      <form
        style={{ display: "flex", gap: 6 }}
        onSubmit={(e) => { e.preventDefault(); const t = draft.trim(); if (t) props.onAnswer(t); }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="type your own answer…"
          style={{ flex: 1, fontFamily: "inherit", fontSize: 11, background: "#0D0D12", color: "#C9C9D6", border: "2px solid #2A2A38", padding: "6px 8px" }}
        />
        <button type="submit" style={{ ...btn, borderColor: "#2A2A38" }}>SEND</button>
      </form>
    </div>
  );
}

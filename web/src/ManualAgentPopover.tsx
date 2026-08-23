import { useState } from "react";
import type { FigState, ManualAgent, ZoneId } from "./sessions";

const MONO = "'JetBrains Mono', ui-monospace, monospace";
const STATES: FigState[] = ["idle", "thinking", "awaiting", "speaking"];

/** Small popover for placing or editing a decorative "manual" agent on a desk.
 * Add mode (from an empty desk / zone) collects a name + state. Edit mode
 * (from an existing manual figure) pre-fills both and offers Remove. */
export function ManualAgentPopover(props: {
  mode: "add" | "edit";
  zone: ZoneId;
  slot: number;
  defaultName: string;
  agent?: ManualAgent;
  onAdd: (name: string, state: FigState) => void;
  onUpdate: (patch: Partial<ManualAgent>) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(props.agent?.name ?? props.defaultName);
  const [figState, setFigState] = useState<FigState>(props.agent?.state ?? "idle");

  const submit = () => {
    const n = name.trim() || props.defaultName;
    if (props.mode === "add") props.onAdd(n, figState);
    else props.onUpdate({ name: n, state: figState });
    props.onClose();
  };

  return (
    <div onClick={props.onClose} style={{ position: "fixed", inset: 0, background: "rgba(5,5,8,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 55 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(300px, 92vw)", background: "#101017", border: "2px solid #2A2A38", fontFamily: MONO, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 11px", borderBottom: "2px solid #2A2A38" }}>
          <span style={{ fontSize: 11, letterSpacing: 2, color: "#C9C9D6" }}>{props.mode === "add" ? "PLACE AGENT" : "EDIT AGENT"}</span>
          <span style={{ fontSize: 9, letterSpacing: 1, color: "#6B6B7B" }}>{props.zone.toUpperCase()}</span>
        </div>
        <div style={{ padding: 11, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 9, letterSpacing: 1, color: "#6B6B7B" }}>NAME</label>
            <input autoFocus type="text" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") props.onClose(); }}
              style={{ fontSize: 11, color: "#C9C9D6", background: "#15151C", border: "2px solid #2A2A38", padding: "6px 7px", outline: "none", fontFamily: MONO }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 9, letterSpacing: 1, color: "#6B6B7B" }}>STATE</label>
            <div style={{ display: "flex", gap: 4 }}>
              {STATES.map((s) => (
                <button key={s} type="button" onClick={() => setFigState(s)}
                  style={{ flex: 1, fontFamily: MONO, fontSize: 9, letterSpacing: 1, textTransform: "uppercase", cursor: "pointer", padding: "6px 2px", background: figState === s ? "#22D3EE" : "#15151C", color: figState === s ? "#0D0D12" : "#C9C9D6", border: `2px solid ${figState === s ? "#22D3EE" : "#2A2A38"}` }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
            <button type="button" onClick={submit} style={{ flex: 1, fontFamily: MONO, fontSize: 10, letterSpacing: 2, background: "#22D3EE", color: "#0D0D12", border: 0, padding: "7px 10px", cursor: "pointer" }}>{props.mode === "add" ? "ADD" : "SAVE"}</button>
            {props.mode === "edit" && (
              <button type="button" onClick={() => { props.onRemove(); props.onClose(); }} style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1, background: "#15151C", color: "#F87171", border: "2px solid #2A2A38", padding: "5px 10px", cursor: "pointer" }}>REMOVE</button>
            )}
            <button type="button" onClick={props.onClose} style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1, background: "#15151C", color: "#6B6B7B", border: "2px solid #2A2A38", padding: "5px 10px", cursor: "pointer" }}>✕</button>
          </div>
        </div>
      </div>
    </div>
  );
}

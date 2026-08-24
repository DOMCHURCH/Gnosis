const MONO = "'JetBrains Mono', ui-monospace, monospace";

/**
 * Design-mode before/after viewer. When /design captures the running dev server —
 * initially, then automatically after each web-file edit — the latest pair renders
 * here beside the code diff: the "before" (prior shot) and "after" (current) side
 * by side, so the model's UI change is visible, not just the code.
 */
export function DesignPanel(props: { shot: { path: string; before: string | null; after: string }; onClose: () => void }) {
  const { shot } = props;
  return (
    <div style={{ border: "2px solid #2A2A38", background: "#101017", fontFamily: MONO }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 9px", borderBottom: "1px solid #2A2A38" }}>
        <span style={{ fontSize: 9, letterSpacing: 2, color: "#E879F9" }}>DESIGN</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 10, color: "#6B6B7B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {shot.path ? `after edit · ${shot.path}` : "current UI"}
        </span>
        <button type="button" onClick={props.onClose} title="dismiss" style={{ fontFamily: MONO, fontSize: 11, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer" }}>✕</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: shot.before ? "1fr 1fr" : "1fr", gap: 1, background: "#2A2A38" }}>
        {shot.before && (
          <div style={{ background: "#0B0B10", display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 8, letterSpacing: 1, color: "#6B6B7B", padding: "3px 6px" }}>BEFORE</div>
            <img src={shot.before} alt="before" style={{ width: "100%", display: "block", borderTop: "1px solid #17171F" }} />
          </div>
        )}
        <div style={{ background: "#0B0B10", display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 8, letterSpacing: 1, color: "#4ADE80", padding: "3px 6px" }}>{shot.before ? "AFTER" : "CURRENT"}</div>
          <img src={shot.after} alt="after" style={{ width: "100%", display: "block", borderTop: "1px solid #17171F" }} />
        </div>
      </div>
    </div>
  );
}

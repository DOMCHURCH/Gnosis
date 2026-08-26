import { useEffect, useMemo, useRef, useState } from "react";
import type { OverlayState } from "./types";
import { Z } from "./layers";

// The web mirror of a TUI selection picker (/model, /resume, @-file, Ctrl+R
// history). It renders whatever list the server sent via `overlay.open`, filters
// as you type, moves with the arrow keys, selects with Enter, and cancels with
// Esc. It sends `overlay.select`/`overlay.cancel` back; the TUI and this modal
// share one request, so whichever answers first resolves it and the other closes
// (the store clears `overlay` on the `overlay.resolved` echo).

const KIND_HINT: Record<string, string> = {
  model: "switch the active model",
  session: "resume a prior session",
  file: "insert a file path",
  history: "reverse-search your prompts",
  rewind: "pick a turn to rewind to",
  "rewind-action": "what should happen to this turn?",
};

/** Rewind renders as a TIMELINE rather than a filter list: the turns are a
 *  sequence you scrub through, and a connected spine reads that way at a glance
 *  where a flat list of rows does not. */
function isTimeline(kind: string): boolean {
  return kind === "rewind";
}

export function OverlayModal(props: { overlay: OverlayState; onSelect: (value: string) => void; onCancel: () => void }) {
  const { overlay, onSelect, onCancel } = props;
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Guard against double-submit (Enter + the resolved echo racing).
  const doneRef = useRef(false);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return overlay.items;
    return overlay.items.filter((it) => it.label.toLowerCase().includes(q) || it.value.toLowerCase().includes(q));
  }, [overlay.items, filter]);

  // Focus the filter on open; start the cursor on the current selection if any.
  useEffect(() => {
    inputRef.current?.focus();
    const i = overlay.selected ? overlay.items.findIndex((it) => it.value === overlay.selected) : -1;
    setActive(i >= 0 ? i : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay.id]);

  // Keep the active row in view and clamped to the filtered range.
  useEffect(() => {
    if (active >= filtered.length) setActive(Math.max(0, filtered.length - 1));
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active, filtered.length]);

  const pick = (value: string) => { if (!doneRef.current) { doneRef.current = true; onSelect(value); } };
  const cancel = () => { if (!doneRef.current) { doneRef.current = true; onCancel(); } };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(filtered.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); const it = filtered[active]; if (it) pick(it.value); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  };

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) cancel(); }}
      style={{ position: "fixed", inset: 0, zIndex: Z.overlay, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(6,6,10,0.72)", backdropFilter: "blur(2px)" }}
    >
      <div onKeyDown={onKeyDown} style={{ width: "min(680px, 92vw)", maxHeight: "72vh", display: "flex", flexDirection: "column", background: "#101018", border: "1px solid #2A2A38", borderRadius: 10, boxShadow: "0 24px 64px rgba(0,0,0,0.6)", overflow: "hidden", font: "13px ui-monospace, 'SF Mono', Menlo, monospace" }}>
        <div style={{ padding: "12px 16px 10px", borderBottom: "1px solid #1E1E28" }}>
          <div style={{ color: "#E5E5EE", fontSize: 13, letterSpacing: "0.02em" }}>{overlay.title || KIND_HINT[overlay.kind] || overlay.kind}</div>
          <input
            ref={inputRef}
            value={filter}
            onChange={(e) => { setFilter(e.target.value); setActive(0); }}
            placeholder="type to filter · ↑↓ move · ↵ select · esc cancel"
            spellCheck={false}
            style={{ marginTop: 8, width: "100%", boxSizing: "border-box", background: "#0A0A10", color: "#C9C9D6", border: "1px solid #2A2A38", borderRadius: 6, padding: "7px 10px", outline: "none", font: "inherit" }}
          />
        </div>
        <div ref={listRef} style={{ overflowY: "auto", padding: "6px 6px 8px" }}>
          {filtered.length === 0 ? (
            <div style={{ padding: "14px 12px", color: "#5A5A68" }}>no matches</div>
          ) : (
            filtered.map((it, i) => (
              <div
                key={it.value + i}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); pick(it.value); }}
                style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", padding: "6px 10px", borderRadius: 6, cursor: "pointer", background: i === active ? "#1B2540" : "transparent", color: i === active ? "#E5E5EE" : "#B4B4C2" }}
              >
                {isTimeline(overlay.kind) && (
                  // The spine: a dot per turn joined by a rule, so the list reads
                  // as a sequence you are moving back along.
                  <span style={{ position: "relative", flexShrink: 0, width: 14, alignSelf: "stretch", display: "flex", justifyContent: "center" }}>
                    <span style={{ position: "absolute", top: 0, bottom: 0, width: 1, background: "#2A2A38" }} />
                    <span style={{ position: "relative", marginTop: 5, width: 7, height: 7, borderRadius: 7, background: i === active ? "#22D3EE" : "#3A3A4A" }} />
                  </span>
                )}
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.label}</span>
                {it.value === overlay.selected ? <span style={{ color: "#22D3EE", fontSize: 11, flexShrink: 0 }}>current</span> : null}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

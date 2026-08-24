import { useState, type RefObject } from "react";
import type { FloorLayout, ZoneId } from "./sessions";
import { MINIMAP_W, MINIMAP_H, minimapModel, minimapViewport, centerScrollLeft } from "./sessions.js";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

/**
 * A 120x90 scale model of the office floor, pinned bottom-left inside the floor
 * container. Every zone is a labelled square in its accent colour — dim when idle,
 * bright when it holds agents — so all five stay visible even when the floor is
 * zoomed past the viewport. A white outline marks what is currently on screen, and
 * clicking a square scrolls the floor to centre that zone.
 *
 * `scrollRef` is the horizontally-scrolling wrapper around the floor SVG; the
 * viewport outline and the click-to-centre scroll both read/write it directly (it
 * is a native scroll position, not React state). `epoch` changes on every scroll or
 * zoom so the outline re-reads those live measurements.
 */
export function FloorMinimap(props: {
  L: FloorLayout;
  scrollRef: RefObject<HTMLDivElement>;
  /** Bumped by the parent on scroll/zoom so the viewport outline recomputes. */
  epoch: number;
  /** Phones start collapsed to a single icon — the floor is small enough already. */
  mobile?: boolean;
}) {
  const [open, setOpen] = useState(!props.mobile);
  const cells = minimapModel(props.L);
  const el = props.scrollRef.current;
  // props.epoch is read purely to re-run this on scroll/zoom.
  void props.epoch;
  const view = el ? minimapViewport(el.scrollLeft, el.clientWidth, el.scrollWidth) : null;

  const goto = (cx: number) => {
    const node = props.scrollRef.current;
    if (!node) return;
    node.scrollTo({ left: centerScrollLeft(cx, node.clientWidth, node.scrollWidth), behavior: "smooth" });
  };

  if (!open) {
    return (
      <button type="button" title="show the floor minimap" onClick={() => setOpen(true)}
        style={{ position: "absolute", left: 8, bottom: 14, zIndex: 3, fontFamily: MONO, fontSize: 12, lineHeight: 1, width: 26, height: 26, background: "#15151C", color: "#6B6B7B", border: "2px solid #2A2A38", cursor: "pointer" }}>◫</button>
    );
  }

  return (
    <div style={{ position: "absolute", left: 8, bottom: 14, zIndex: 3, background: "#15151C", border: "2px solid #2A2A38", fontFamily: MONO, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 4px", borderBottom: "2px solid #2A2A38" }}>
        <span style={{ fontSize: 8, letterSpacing: 1, color: "#6B6B7B" }}>MAP</span>
        {/* Dismissible everywhere: the panel sits over the bottom-left desks, so the
            user always has a way to get them back. */}
        <button type="button" title="hide the minimap" onClick={() => setOpen(false)}
          style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 10, lineHeight: 1, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer", padding: 0 }}>✕</button>
      </div>
      <svg width={MINIMAP_W} height={MINIMAP_H} viewBox={`0 0 ${MINIMAP_W} ${MINIMAP_H}`} shapeRendering="crispEdges" style={{ display: "block" }}>
        <rect x="0" y="0" width={MINIMAP_W} height={MINIMAP_H} fill="#15151C" />
        {cells.map((c) => (
          <g key={c.key} onClick={() => goto(c.cx)} style={{ cursor: "pointer" }}>
            <title>{`${c.zone} — click to centre`}</title>
            <rect x={c.x} y={c.y} width={c.w} height={c.h} fill={c.color} fillOpacity={c.active ? 0.5 : 0.12} />
            <rect x={c.x} y={c.y} width={c.w} height={c.h} fill="none" stroke={c.color} strokeOpacity={c.active ? 0.9 : 0.3} strokeWidth="1" />
            <text x={c.x + c.w / 2} y={c.y + c.h / 2 + 3} textAnchor="middle" fontFamily={MONO} fontSize="8"
              fill={c.active ? "#C9C9D6" : "#6B6B7B"}>{c.label}</text>
          </g>
        ))}
        {view && <rect x={view.x} y={view.y} width={view.w} height={view.h} fill="none" stroke="#C9C9D6" strokeWidth="1" />}
      </svg>
    </div>
  );
}

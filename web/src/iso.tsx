// THROWAWAY prototype harness — not shipped, not committed.
// Renders the office floor three ways side by side so the isometric conversion can
// be judged from a real browser screenshot before any of it lands:
//   A  flat        — what ships today
//   B  css-iso     — the spec as written: rotateX(60deg) rotateZ(-45deg) on the
//                    whole floor container, sprites left as flat SVG
//   C  billboard   — ground plane tilted, desks + agents kept upright on top
import { createRoot } from "react-dom/client";
import { FloorGraphic } from "./FloorGraphic";
import { layoutFloor, ZONES } from "./sessions.js";
import "./styles.css";

// A representative floor: every zone occupied, a mix of states and colour variants.
const FIGS = [
  { id: "f1", zone: "coordinator", name: "main", state: "thinking", action: "routing", output: [], thinking: [] },
  { id: "f2", zone: "planning", name: "plan", state: "speaking", action: "drafting", output: [], thinking: [] },
  { id: "f3", zone: "planning", name: "spec", state: "idle", action: "idle", output: [], thinking: [] },
  { id: "f4", zone: "application", name: "vite", state: "thinking", action: "dev server", output: [], thinking: [] },
  { id: "f5", zone: "application", name: "tests", state: "awaiting", action: "verify", output: [], thinking: [] },
  { id: "f6", zone: "coding", name: "edit-1", state: "thinking", action: "editing", output: [], thinking: [] },
  { id: "f7", zone: "coding", name: "edit-2", state: "thinking", action: "editing", output: [], thinking: [] },
  { id: "f8", zone: "coding", name: "edit-3", state: "idle", action: "idle", output: [], thinking: [] },
  { id: "f9", zone: "coding", name: "edit-4", state: "awaiting", action: "waiting", output: [], thinking: [] },
  { id: "f10", zone: "subagents", name: "sub-a", state: "thinking", action: "task()", output: [], thinking: [] },
  { id: "f11", zone: "subagents", name: "sub-b", state: "thinking", action: "task()", output: [], thinking: [] },
  { id: "f12", zone: "subagents", name: "sub-c", state: "idle", action: "task()", output: [], thinking: [] },
];

const L = layoutFloor(FIGS as never, null, [], []);
const noop = () => {};

const W = 1440, H = 900;
const R2 = Math.SQRT2;
/** Screen offset of a floor point under rotateX(60deg) rotateZ(-45deg), measured
 *  from the floor's centre. Same matrix the CSS applies, so billboarded props land
 *  exactly where the tilted ground puts their tile. */
function project(x: number, y: number) {
  const dx = x - W / 2, dy = y - H / 2;
  return { X: (dx + dy) / R2, Y: (dy - dx) / (2 * R2) };
}

function Frame(props: { title: string; note: string; children: React.ReactNode }) {
  return (
    <div className="isoframe" style={{ marginBottom: 28 }}>
      <div style={{ font: "700 14px ui-monospace, monospace", color: "#C9C9D6", letterSpacing: 1, padding: "0 0 2px" }}>{props.title}</div>
      <div style={{ font: "12px ui-monospace, monospace", color: "#6B6B7B", padding: "0 0 8px" }}>{props.note}</div>
      <div style={{ width: 1200, height: 760, background: "#0D0D12", border: "1px solid #262633", overflow: "hidden", position: "relative" }}>
        {props.children}
      </div>
    </div>
  );
}

/** A — current shipping renderer. */
function Flat() {
  return (
    <div style={{ position: "relative", width: 1200 }}>
      <FloorGraphic L={L} onSelectFig={noop} onDeskClick={noop} />
    </div>
  );
}

/** B — the spec exactly as written: one CSS transform on the whole floor. */
function CssIso() {
  return (
    <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", perspective: 2000 }}>
      <div style={{ transformStyle: "preserve-3d", transform: "scale(0.62) rotateX(60deg) rotateZ(-45deg)", width: 1200, position: "relative" }}>
        <FloorGraphic L={L} onSelectFig={noop} onDeskClick={noop} />
      </div>
    </div>
  );
}

/** C — ground tilted, props billboarded upright at their projected tile. */
function Billboard() {
  const S = 0.62;         // fit the widened iso footprint into the frame
  const props_ = [...L.placed].sort((a, b) => (a.deskY - b.deskY) || (a.deskX - b.deskX));
  return (
    <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", overflow: "hidden" }}>
      <div style={{ position: "relative", width: 0, height: 0 }}>
        {/* ground plane — tilted */}
        <div style={{ position: "absolute", left: -W / 2 * S, top: -H / 2 * S, width: W * S, height: H * S, transformStyle: "preserve-3d", transform: "rotateX(60deg) rotateZ(-45deg)" }}>
          <div style={{ width: W * S }}>
            <FloorGraphic L={L} layer="ground" onSelectFig={noop} onDeskClick={noop} />
          </div>
        </div>
        {/* props — upright, positioned at the projected tile of their desk */}
        {props_.map((a) => {
          const p = project(a.deskX + 60, a.deskY);
          return (
            <div key={a.key} style={{ position: "absolute", left: p.X * S, top: p.Y * S, transform: "translate(-50%, -100%)", width: 150 * S }}>
              <svg viewBox={`${a.deskX - 10} ${a.deskY - 150} 150 200`} width={150 * S} shapeRendering="crispEdges">
                <use href="#desk" x={a.deskX} y={a.deskY} style={{ color: a.color }} />
                <g transform={a.figTransform}>
                  <use href="#agBody" x={a.agX} y={a.agY} style={{ color: a.color }} opacity={a.opacity} />
                  <use href="#armL" x={a.agX} y={a.agY} style={{ color: a.color, ...(a.armL || {}) }} opacity={a.opacity} />
                  <use href="#armR" x={a.agX} y={a.agY} style={{ color: a.color, ...(a.armR || {}) }} opacity={a.opacity} />
                </g>
              </svg>
            </div>
          );
        })}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <div style={{ background: "#0D0D12", padding: 24, minHeight: "100vh" }}>
    {/* one hidden copy supplies the <defs> sprite library the billboards <use> */}
    <div style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }} aria-hidden>
      <FloorGraphic L={L} onSelectFig={noop} onDeskClick={noop} />
    </div>
    <Frame title="A — FLAT (ships today)" note="top-down floor plane, front-view desks and figures">
      <Flat />
    </Frame>
    <Frame title="B — CSS ISO (spec as written)" note='rotateX(60deg) rotateZ(-45deg) on the floor container, sprites unchanged'>
      <CssIso />
    </Frame>
    <Frame title="C — BILLBOARD (proposed)" note="ground plane tilted, desks and agents kept upright on top of it">
      <Billboard />
    </Frame>
  </div>
);

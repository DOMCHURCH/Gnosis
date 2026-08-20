import { FLOORS } from "./floors.js";
import type { Building as BuildingModel, Figure } from "./floors";

const FLOOR_H = 96;
const W = 820;
const PAD_X = 160; // left label gutter
const STEP = 92;

// A floor-based view of the agents, driven by the same event stream as the
// transcript. An agent stands on the floor matching its state (plan → Planning,
// active edit → Coding, running job → Application, else Coordinator); sub-agents
// appear on the Sub-agents floor and leave when they return. Figures CSS-transition
// their position, so a state change slides them between floors. Plain SVG geometry
// — no third-party sprite/tileset assets.
export function Building({ model, onPick }: { model: BuildingModel; onPick: (id: number) => void }) {
  const H = FLOORS.length * FLOOR_H;
  const pos = new Map<number | string, { x: number; y: number }>();
  FLOORS.forEach((floor, fi) => {
    model.floors[floor].forEach((f, i) => pos.set(f.id, { x: PAD_X + i * STEP, y: fi * FLOOR_H + FLOOR_H / 2 }));
  });

  return (
    <svg className="building" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMin meet">
      {FLOORS.map((floor, fi) => (
        <g key={floor}>
          <rect x={0} y={fi * FLOOR_H} width={W} height={FLOOR_H} className={`floor floor-${fi}`} />
          <line className="floor-line" x1={0} y1={fi * FLOOR_H} x2={W} y2={fi * FLOOR_H} />
          <text className="floor-label" x={16} y={fi * FLOOR_H + 26}>
            {floor}
          </text>
        </g>
      ))}

      {model.links.map((l) => {
        const a = pos.get(l.from);
        const b = pos.get(l.to);
        if (!a || !b) return null;
        return <line key={l.key} className="msg-link" x1={a.x} y1={a.y - 6} x2={b.x} y2={b.y - 6} />;
      })}

      {FLOORS.map((floor) =>
        model.floors[floor].map((f) => {
          const p = pos.get(f.id)!;
          return <FigureG key={f.id} f={f} x={p.x} y={p.y} onPick={onPick} />;
        }),
      )}
    </svg>
  );
}

function FigureG({ f, x, y, onPick }: { f: Figure; x: number; y: number; onPick: (id: number) => void }) {
  const clickable = f.kind === "agent";
  return (
    <g
      className={`figure ${f.kind} ${f.busy ? "busy" : ""}`}
      transform={`translate(${x},${y})`}
      onClick={() => clickable && onPick(f.id as number)}
      style={{ cursor: clickable ? "pointer" : "default" }}
    >
      {f.busy && <circle className="busy-ring" r={22} />}
      <circle className="head" cy={-14} r={7} />
      <rect className="body" x={-8} y={-4} width={16} height={22} rx={5} />
      {f.awaitingPermission && <circle className="perm" cx={13} cy={-20} r={5} />}
      <text className="fig-name" y={36}>
        {f.name}
      </text>
    </g>
  );
}

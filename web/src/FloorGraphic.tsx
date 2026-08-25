import type { FloorLayout, ZoneId } from "./sessions";
import { ZONE_DEPTH } from "./sessions.js";
import type { TaskPlan } from "./taskplan";
import { TaskPlanView } from "./TaskPlanView";

/**
 * The office-floor SVG (desks, agents, zones) plus its absolutely-positioned label
 * overlay. Extracted so the same graphic renders in the desktop center column AND
 * full-width on mobile's FLOOR tab — one source of truth for the floor.
 */
export function FloorGraphic(props: {
  L: FloorLayout;
  plan?: TaskPlan | null;
  onSelectFig: (id: string | null) => void;
  onDeskClick: (zone: ZoneId, slot: number) => void;
  /** "ground" draws only the floor plane (tiles, zone boxes, fixed props); "props"
   *  draws only desks/agents/labels. Used by the isometric renderer, which puts the
   *  ground on a CSS-tilted plane and billboards the props upright on top of it. */
  layer?: "all" | "ground" | "props";
}) {
  const { L } = props;
  const layer = props.layer || "all";
  const ground = layer !== "props";
  const propsL = layer !== "ground";
  return (
    <>
      <svg viewBox="0 0 1440 900" width="100%" preserveAspectRatio="xMidYMid meet" shapeRendering="crispEdges" style={{ display: "block" }} xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id="tile" width="32" height="32" patternUnits="userSpaceOnUse">
            <rect x="0" y="0" width="32" height="32" fill="#23202A" />
            <rect x="0" y="0" width="32" height="2" fill="#282430" />
            <rect x="0" y="0" width="2" height="32" fill="#282430" />
          </pattern>
          <g id="agBody">
            <rect x="16" y="4" width="32" height="12" fill="#3A3038" />
            <rect x="16" y="16" width="32" height="20" fill="#C9C9D6" />
            <rect x="20" y="24" width="8" height="8" fill="#0D0D12" />
            <rect x="36" y="24" width="8" height="8" fill="#0D0D12" />
            <rect x="12" y="36" width="40" height="32" fill="currentColor" />
            <rect x="24" y="36" width="16" height="8" fill="#C9C9D6" />
            <rect x="16" y="68" width="12" height="24" fill="#3A3038" />
            <rect x="36" y="68" width="12" height="24" fill="#3A3038" />
            <rect x="12" y="92" width="16" height="4" fill="#0D0D12" />
            <rect x="36" y="92" width="16" height="4" fill="#0D0D12" />
          </g>
          <g id="armL"><rect x="4" y="40" width="8" height="24" fill="currentColor" fillOpacity="0.6" /></g>
          <g id="armR"><rect x="52" y="40" width="8" height="24" fill="currentColor" fillOpacity="0.6" /></g>
          <g id="desk">
            <rect x="4" y="-48" width="52" height="32" fill="#0F0D16" stroke="#CFC8B7" strokeWidth="2" />
            <rect x="56" y="-44" width="8" height="32" fill="#8E8878" />
            <rect x="8" y="-44" width="44" height="14" fill="currentColor" fillOpacity="0.9" />
            <rect x="8" y="-28" width="26" height="4" fill="#3A3038" />
            <rect x="24" y="-16" width="12" height="8" fill="#B4AC9A" />
            <rect x="16" y="-8" width="28" height="6" fill="#CFC8B7" />
            <rect x="16" y="-2" width="28" height="4" fill="#8E8878" />
            <rect x="0" y="0" width="112" height="22" fill="#4A4252" />
            <rect x="0" y="0" width="112" height="4" fill="#584F62" />
            <rect x="0" y="22" width="112" height="14" fill="#332C3B" />
            <rect x="112" y="4" width="8" height="32" fill="#292330" />
            <rect x="0" y="36" width="120" height="4" fill="#1A171F" />
            <rect x="60" y="4" width="40" height="10" fill="#2A2A38" />
            <rect x="60" y="14" width="40" height="4" fill="#1B1B24" />
          </g>
          <g id="deskEmpty">
            <rect x="4" y="-48" width="52" height="32" fill="#12101A" stroke="#3A3441" strokeWidth="2" />
            <rect x="56" y="-44" width="8" height="32" fill="#3A3441" />
            <rect x="24" y="-16" width="12" height="8" fill="#3A3441" />
            <rect x="16" y="-8" width="28" height="6" fill="#4A4252" />
            <rect x="0" y="0" width="112" height="22" fill="#332C3B" />
            <rect x="0" y="0" width="112" height="4" fill="#3D3547" />
            <rect x="0" y="22" width="112" height="14" fill="#241F2B" />
            <rect x="112" y="4" width="8" height="32" fill="#1F1B25" />
            <rect x="60" y="4" width="40" height="10" fill="#2A2430" />
          </g>
          <g id="busy">
            <rect x="0" y="0" width="8" height="8" fill="currentColor" style={{ animation: "domDot 1.2s steps(1) infinite" }} />
            <rect x="12" y="0" width="8" height="8" fill="currentColor" style={{ animation: "domDot 1.2s steps(1) .2s infinite" }} />
            <rect x="24" y="0" width="8" height="8" fill="currentColor" style={{ animation: "domDot 1.2s steps(1) .4s infinite" }} />
          </g>
          <g id="await" style={{ animation: "domAmberPulse .2s ease-in-out infinite alternate" }}>
            <rect x="0" y="0" width="24" height="24" fill="#FBBF24" />
            <rect x="10" y="4" width="4" height="10" fill="#0D0D12" />
            <rect x="10" y="16" width="4" height="4" fill="#0D0D12" />
          </g>
          <g id="speak" style={{ animation: "domBob 1.6s ease-in-out infinite" }}>
            <rect x="0" y="0" width="24" height="24" fill="#12101A" stroke="#CFC8B7" strokeWidth="2" />
            <rect x="6" y="10" width="4" height="4" fill="#C9C9D6" />
            <rect x="14" y="10" width="4" height="4" fill="#C9C9D6" />
          </g>
          {/* Grounds every zone box so the rooms sit ON the floor instead of being
              painted onto it — the SVG equivalent of box-shadow 0 4px 12px #0006.
              Shadow ONLY: the source is dropped, so the caster rect below is
              invisible and contributes nothing but the shadow it throws. */}
          <filter id="zoneShadow" x="-20%" y="-20%" width="140%" height="160%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="6" />
            <feOffset dy="4" />
            <feComponentTransfer><feFuncA type="linear" slope="0.4" /></feComponentTransfer>
          </filter>
          {/* VAR-A: the monitor bezel washed in the agent's own colour. */}
          <g id="deskGlow">
            <rect x="4" y="-48" width="52" height="32" fill="currentColor" fillOpacity="0.18" />
            <rect x="8" y="-44" width="44" height="14" fill="currentColor" fillOpacity="0.35" />
          </g>
          {/* VAR-C: a second, smaller monitor on the right end of the desk. Sits
              clear of the seated figure (which spans deskX+60..+100) so it is never
              occluded, and inside the desk pitch so it never touches a neighbour. */}
          <g id="deskMonitor2">
            <rect x="98" y="-44" width="34" height="24" fill="#0F0D16" stroke="#CFC8B7" strokeWidth="2" />
            <rect x="102" y="-40" width="26" height="10" fill="currentColor" fillOpacity="0.9" />
            <rect x="102" y="-27" width="14" height="3" fill="#3A3038" />
            <rect x="110" y="-20" width="10" height="6" fill="#B4AC9A" />
            <rect x="104" y="-14" width="22" height="4" fill="#CFC8B7" />
            <rect x="104" y="-10" width="22" height="3" fill="#8E8878" />
          </g>
          <g id="plant">
            <rect x="4" y="8" width="8" height="16" fill="#4ADE80" fillOpacity="0.55" />
            <rect x="12" y="0" width="8" height="24" fill="#4ADE80" fillOpacity="0.7" />
            <rect x="20" y="10" width="8" height="14" fill="#4ADE80" fillOpacity="0.45" />
            <rect x="6" y="24" width="20" height="6" fill="#4A4252" />
            <rect x="6" y="30" width="20" height="12" fill="#332C3B" />
            <rect x="26" y="26" width="6" height="16" fill="#241F2B" />
            <rect x="6" y="42" width="26" height="4" fill="#1A171F" />
          </g>
        </defs>

        {ground && <>
        <rect x="0" y="0" width="1440" height="900" fill="#12111A" />
        <rect x="16" y="16" width="1408" height="868" fill="#CFC8B7" />
        <rect x="32" y="32" width="1376" height="836" fill="url(#tile)" />

        {/* Shadow pass, under every plate, so the zone boxes sit on the floor. */}
        {L.zoneDepth.map((z) => (
          <rect key={`${z.key}-sh`} x={z.x} y={z.y} width={z.w} height={z.h} fill="#000000" opacity={z.dim} filter="url(#zoneShadow)" />
        ))}

        {L.zonePlates.map((z) => (
          z.collapsed && z.zone
            ? <g key={z.key} onClick={() => props.onDeskClick(z.zone!, 0)} style={{ cursor: "pointer" }}>
                <rect x={z.x} y={z.y} width={z.w} height={z.h} fill={z.fill} fillOpacity={z.op} />
                <rect x={z.x + z.w - 44} y={z.y + z.h / 2 - 3} width="20" height="6" fill="#6B6B7B" />
                <rect x={z.x + z.w - 37} y={z.y + z.h / 2 - 10} width="6" height="20" fill="#6B6B7B" />
              </g>
            : <rect key={z.key} x={z.x} y={z.y} width={z.w} height={z.h} fill={z.fill} fillOpacity={z.op} />
        ))}
        {/* Depth shell per zone: a lit ceiling strip along the top, light top/left
            borders and dark bottom/right ones. Read together they fake the shallow
            perspective that turns a flat rectangle into a room. Idle zones render
            the whole shell at 60% so active zones pull focus. */}
        {L.zoneDepth.map((z) => {
          const b = ZONE_DEPTH.border;
          return (
            <g key={z.key} opacity={z.dim}>
              <rect x={z.x} y={z.y} width={z.w} height={b} fill={ZONE_DEPTH.lightEdge} />
              <rect x={z.x} y={z.y} width={b} height={z.h} fill={ZONE_DEPTH.lightEdge} />
              <rect x={z.x} y={z.y + z.h - b} width={z.w} height={b} fill={ZONE_DEPTH.darkEdge} />
              <rect x={z.x + z.w - b} y={z.y} width={b} height={z.h} fill={ZONE_DEPTH.darkEdge} />
              <rect x={z.x + b} y={z.y + b} width={z.w - b * 2} height={ZONE_DEPTH.ceiling} fill={ZONE_DEPTH.ceilingFill} />
            </g>
          );
        })}
        {L.zoneCurbs.map((c) => (
          <rect key={c.key} x={c.x} y={c.y} width={c.w} height={c.h} fill={c.fill} fillOpacity={c.op} />
        ))}

        <rect x="32" y="32" width="1376" height="56" fill="#6B3335" />
        <rect x="32" y="32" width="1376" height="8" fill="#5E2C2F" />
        <rect x="32" y="80" width="1376" height="8" fill="#B4AC9A" />
        <rect x="120" y="44" width="112" height="28" fill="#12101A" stroke="#CFC8B7" strokeWidth="4" />
        <rect x="360" y="44" width="112" height="28" fill="#22D3EE" fillOpacity="0.2" stroke="#CFC8B7" strokeWidth="4" />
        <rect x="600" y="44" width="112" height="28" fill="#12101A" stroke="#CFC8B7" strokeWidth="4" />
        <rect x="840" y="44" width="112" height="28" fill="#12101A" stroke="#CFC8B7" strokeWidth="4" />
        <rect x="1080" y="44" width="112" height="28" fill="#FBBF24" fillOpacity="0.18" stroke="#CFC8B7" strokeWidth="4" />
        <rect x="1272" y="44" width="112" height="28" fill="#12101A" stroke="#CFC8B7" strokeWidth="4" />

        <rect x="408" y="96" width="8" height="120" fill="#CFC8B7" />
        <rect x="408" y="280" width="8" height="120" fill="#CFC8B7" />
        <rect x="768" y="96" width="8" height="176" fill="#CFC8B7" />
        <rect x="768" y="336" width="8" height="524" fill="#CFC8B7" />
        <rect x="32" y="400" width="280" height="8" fill="#CFC8B7" />
        <rect x="392" y="400" width="384" height="8" fill="#CFC8B7" />
        <rect x="776" y="400" width="200" height="8" fill="#CFC8B7" />
        <rect x="1056" y="400" width="352" height="8" fill="#CFC8B7" />

        <rect x="600" y="852" width="176" height="16" fill="#B4AC9A" />
        <rect x="608" y="856" width="80" height="12" fill="#22D3EE" fillOpacity="0.35" />
        <rect x="696" y="856" width="72" height="12" fill="#12101A" />

        <rect x="264" y="196" width="140" height="88" fill="#12101A" stroke="#CFC8B7" strokeWidth="4" />
        <rect x="276" y="208" width="88" height="12" fill="#E879F9" style={{ animation: "domScan 2.4s ease-in-out infinite" }} />
        <rect x="276" y="228" width="24" height="12" fill="#818CF8" />
        <rect x="308" y="228" width="24" height="12" fill="#22D3EE" />
        <rect x="340" y="228" width="24" height="12" fill="#4ADE80" />
        <rect x="276" y="248" width="108" height="8" fill="#3A3038" />
        <use href="#plant" x="60" y="196" />

        <rect x="1136" y="150" width="248" height="152" fill="#12101A" stroke="#CFC8B7" strokeWidth="4" />
        <rect x="1148" y="162" width="224" height="20" fill="#1B1922" />
        <rect x="1156" y="168" width="8" height="8" fill="#4ADE80" />
        <rect x="1172" y="168" width="8" height="8" fill="#3A3038" />
        <rect x="1188" y="168" width="8" height="8" fill="#3A3038" />
        <rect x="1148" y="194" width="120" height="24" fill="#4ADE80" fillOpacity="0.85" />
        <rect x="1148" y="228" width="176" height="10" fill="#3A3038" />
        <rect x="1148" y="246" width="136" height="10" fill="#3A3038" />
        <rect x="1148" y="266" width="88" height="12" fill="#4ADE80" style={{ animation: "domScan 1.8s ease-in-out infinite" }} />
        <use href="#plant" x="728" y="188" />

        <rect x="1320" y="548" width="72" height="12" fill="#4A4252" />
        <rect x="1320" y="560" width="72" height="180" fill="#2A2328" stroke="#3A3441" strokeWidth="2" />
        <rect x="1332" y="576" width="48" height="8" fill="#22D3EE" fillOpacity="0.5" />
        <rect x="1332" y="594" width="48" height="8" fill="#3A3038" />
        <rect x="1332" y="612" width="48" height="8" fill="#3A3038" />
        <rect x="1332" y="630" width="48" height="8" fill="#3A3038" />
        <rect x="1332" y="648" width="48" height="8" fill="#22D3EE" fillOpacity="0.35" />
        <rect x="1332" y="666" width="48" height="8" fill="#3A3038" />
        <rect x="1320" y="740" width="80" height="4" fill="#1A171F" />
        </>}

        {propsL && L.freeDesks.map((d) => (
          <g key={d.key} onClick={() => props.onDeskClick(d.zone, d.slot)} style={{ cursor: "pointer" }}>
            <use href="#deskEmpty" x={d.x} y={d.y} opacity="0.55" />
            {/* a dim "+" marks the desk as placeable */}
            <rect x={d.x + 44} y={d.y - 66} width="24" height="6" fill="#6B6B7B" opacity="0.7" />
            <rect x={d.x + 53} y={d.y - 75} width="6" height="24" fill="#6B6B7B" opacity="0.7" />
          </g>
        ))}

        {propsL && L.placed.map((a) => (
          <g key={a.key} onClick={() => props.onSelectFig(a.id)} style={{ cursor: "pointer" }}>
            <use href="#desk" x={a.deskX} y={a.deskY} style={{ color: a.color }} />
            {a.deskGlow && <use href="#deskGlow" x={a.deskX} y={a.deskY} style={{ color: a.color }} opacity={a.opacity} />}
            {a.deskSecondMonitor && <use href="#deskMonitor2" x={a.deskX} y={a.deskY} style={{ color: a.color }} opacity={a.opacity} />}
            {/* Busy agents scale to 110% behind a soft cyan glow; VAR-B carries a
                little extra height. Both ride one transform about the foot line. */}
            <g transform={a.figTransform} style={a.figFilter ? { filter: a.figFilter } : undefined}>
              <use href="#agBody" x={a.agX} y={a.agY} style={{ color: a.color }} opacity={a.opacity} />
              <use href="#armL" x={a.agX} y={a.agY} style={{ color: a.color, ...(a.armL || {}) }} opacity={a.opacity} />
              <use href="#armR" x={a.agX} y={a.agY} style={{ color: a.color, ...(a.armR || {}) }} opacity={a.opacity} />
            </g>
            {a.isThinking && <use href="#busy" x={a.cueX} y={a.cueY} style={{ color: a.color }} />}
            {a.isAwaiting && <use href="#await" x={a.cueX} y={a.cueYBig} />}
            {a.isSpeaking && <use href="#speak" x={a.cueX} y={a.cueYBig} />}
            {a.selected && <rect x={a.ringX} y={a.ringY} width="80" height="112" fill="none" stroke={a.color} strokeWidth="4" />}
          </g>
        ))}
      </svg>

      {propsL && <div style={{ position: "absolute", inset: 0, containerType: "size", pointerEvents: "none" }}>
        {L.zoneLabels.map((z) => (
          <div key={z.key} onClick={() => props.onDeskClick(z.zone as ZoneId, 0)} style={{ position: "absolute", left: z.left, top: z.top, display: "flex", flexDirection: "column", gap: "0.3cqw", whiteSpace: "nowrap", pointerEvents: "auto", cursor: "pointer" }}>
            {/* Active zones render their name at full #C9C9D6; idle ones drop to the
                dim grey (the model decides — see layoutFloor). */}
            <span style={{ fontSize: "1.45cqw", fontWeight: 700, letterSpacing: "0.22cqw", color: z.accent }}>{z.name}</span>
            <span style={{ fontSize: "1.05cqw", letterSpacing: "0.08cqw", color: z.countColor }}>{z.count}</span>
            {z.hint && <span style={{ fontSize: "0.92cqw", letterSpacing: "0.04cqw", color: "#4A4A58" }}>{z.hint}</span>}
          </div>
        ))}
        {L.nameTags.map((n) => (
          <div key={n.key} style={{ position: "absolute", left: n.left, top: n.top, transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: "0.4cqw", background: "#0D0D12E6", border: `0.16cqw solid ${n.border}`, padding: "0.25cqw 0.5cqw", whiteSpace: "nowrap" }}>
            <span style={{ width: "0.6cqw", height: "0.6cqw", background: n.stateColor }} />
            <span style={{ fontSize: "1cqw", letterSpacing: "0.08cqw", color: "#C9C9D6" }}>{n.name}</span>
          </div>
        ))}
        {/* Coordinated-task plan floating above the coordinator desk (zone 01). */}
        {props.plan && (
          <div style={{ position: "absolute", left: "2.8%", top: "1.5%", pointerEvents: "auto", zIndex: 4 }}>
            <TaskPlanView plan={props.plan} compact />
          </div>
        )}
      </div>}
    </>
  );
}

import { ZONES, agentGeom } from "./office.js";
import type { AgentGeom, OfficeAgent, OfficeModel, ZoneName } from "./office";

export interface ChatMsg { key: string; from: string; color: string; text: string; time: string; border: string; }
export interface Mention { key: string; label: string; color: string; border: string; onClick: () => void; }

export interface OfficeProps {
  model: OfficeModel;
  selectedId: number | string | null;
  chat: ChatMsg[];
  draft: string;
  steer: string;
  chatTarget: string;
  ctxLine: string;
  mentions: Mention[];
  onSelect: (id: number | string) => void;
  onClose: () => void;
  onSteer: () => void;
  onSteerDraft: (v: string) => void;
  onApprove: () => void;
  onDeny: () => void;
  onToggleIdle: () => void;
  onDismiss: () => void;
  onDraft: (v: string) => void;
  onSend: () => void;
  onSpawn: () => void;
}

const MONO = "'JetBrains Mono', ui-monospace, monospace";

export function OfficeFloor(props: OfficeProps) {
  const { model, selectedId } = props;
  const geoms = model.placed.map((a) => ({ a, g: agentGeom(a, selectedId) }));
  const allAgents: OfficeAgent[] = [...model.placed, ...(model.offFloor as OfficeAgent[])];
  const sel = allAgents.find((a) => a.id === selectedId) || null;
  const total = allAgents.length;

  return (
    <div style={{ minHeight: "100%", background: "#0D0D12", color: "#C9C9D6", fontFamily: MONO, padding: 28, boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 20, alignItems: "center" }}>
      <div style={{ width: "100%", maxWidth: 1560, display: "flex", alignItems: "flex-end", justifyContent: "space-between", borderBottom: "2px solid #2A2A38", paddingBottom: 14, gap: 24, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
          <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: 4 }}>dom</span>
          <span style={{ fontSize: 11, color: "#6B6B7B", letterSpacing: 2, whiteSpace: "nowrap" }}>FLOOR 01 · THE OFFICE</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 20, fontSize: 11, letterSpacing: 2, color: "#6B6B7B" }}>
          <span style={{ color: "#FBBF24", whiteSpace: "nowrap" }}>{model.awaiting} {model.awaiting === 1 ? "AWAITING APPROVAL" : "AWAITING APPROVALS"}</span>
          <span style={{ whiteSpace: "nowrap" }}>{total} AGENTS · {model.offFloor.length} OFF-FLOOR</span>
        </div>
      </div>

      <div style={{ width: "100%", maxWidth: 1560, display: "flex", flexWrap: "wrap", gap: 20, alignItems: "stretch" }}>
        {/* ---- floor ---- */}
        <div style={{ flex: "1 1 760px", minWidth: "min(100%, 760px)", background: "#15151C", border: "2px solid #2A2A38", padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, letterSpacing: 2, color: "#6B6B7B" }}>OFFICE FLOOR · 8PX GRID · CLICK AN AGENT</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={props.onSpawn} style={{ fontFamily: "inherit", fontSize: 10, letterSpacing: 1, background: "#101017", color: "#22D3EE", border: "2px solid #22D3EE", padding: "5px 10px", cursor: "pointer" }}>+ AGENT</button>
            </div>
          </div>

          <div style={{ overflowX: "auto", overflowY: "hidden" }}>
            <div style={{ position: "relative", minWidth: 1040 }}>
              <svg viewBox="0 0 1280 800" width="100%" shapeRendering="crispEdges" style={{ display: "block" }} xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <pattern id="floorTile" width="32" height="32" patternUnits="userSpaceOnUse">
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
                  <g id="await" style={{ animation: "domBlink 1.1s steps(1) infinite" }}>
                    <rect x="0" y="0" width="24" height="24" fill="#FBBF24" />
                    <rect x="10" y="4" width="4" height="10" fill="#0D0D12" />
                    <rect x="10" y="16" width="4" height="4" fill="#0D0D12" />
                  </g>
                  <g id="speak" style={{ animation: "domBob 1.6s ease-in-out infinite" }}>
                    <rect x="0" y="0" width="24" height="24" fill="#12101A" stroke="#CFC8B7" strokeWidth="2" />
                    <rect x="6" y="10" width="4" height="4" fill="#C9C9D6" />
                    <rect x="14" y="10" width="4" height="4" fill="#C9C9D6" />
                  </g>
                  <g id="chair">
                    <rect x="0" y="0" width="32" height="10" fill="#544B5E" />
                    <rect x="0" y="10" width="32" height="6" fill="#3A3441" />
                    <rect x="32" y="2" width="6" height="14" fill="#2E2934" />
                    <rect x="12" y="16" width="8" height="10" fill="#2E2934" />
                    <rect x="6" y="26" width="20" height="4" fill="#1F1B25" />
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

                <rect x="0" y="0" width="1280" height="800" fill="#12111A" />
                <rect x="16" y="16" width="1248" height="768" fill="#CFC8B7" />
                <rect x="32" y="32" width="1216" height="736" fill="url(#floorTile)" />

                <rect x="40" y="96" width="344" height="272" fill="#E879F9" fillOpacity="0.05" />
                <rect x="392" y="96" width="376" height="272" fill="#818CF8" fillOpacity="0.04" />
                <rect x="776" y="96" width="472" height="304" fill="#4ADE80" fillOpacity="0.04" />
                <rect x="40" y="376" width="728" height="384" fill="#22D3EE" fillOpacity="0.04" />
                <rect x="776" y="408" width="472" height="352" fill="#C084FC" fillOpacity="0.03" />

                <rect x="32" y="32" width="1216" height="56" fill="#6B3335" />
                <rect x="32" y="32" width="1216" height="8" fill="#5E2C2F" />
                <rect x="32" y="80" width="1216" height="8" fill="#B4AC9A" />
                <rect x="120" y="44" width="112" height="28" fill="#12101A" stroke="#CFC8B7" strokeWidth="4" />
                <rect x="320" y="44" width="112" height="28" fill="#22D3EE" fillOpacity="0.2" stroke="#CFC8B7" strokeWidth="4" />
                <rect x="520" y="44" width="112" height="28" fill="#12101A" stroke="#CFC8B7" strokeWidth="4" />
                <rect x="720" y="44" width="112" height="28" fill="#12101A" stroke="#CFC8B7" strokeWidth="4" />
                <rect x="920" y="44" width="112" height="28" fill="#FBBF24" fillOpacity="0.18" stroke="#CFC8B7" strokeWidth="4" />
                <rect x="1104" y="44" width="112" height="28" fill="#12101A" stroke="#CFC8B7" strokeWidth="4" />

                <rect x="384" y="96" width="8" height="112" fill="#CFC8B7" />
                <rect x="384" y="272" width="8" height="96" fill="#CFC8B7" />
                <rect x="768" y="96" width="8" height="176" fill="#CFC8B7" />
                <rect x="768" y="336" width="8" height="400" fill="#CFC8B7" />
                <rect x="32" y="368" width="264" height="8" fill="#CFC8B7" />
                <rect x="368" y="368" width="408" height="8" fill="#CFC8B7" />
                <rect x="776" y="400" width="176" height="8" fill="#CFC8B7" />
                <rect x="1024" y="400" width="224" height="8" fill="#CFC8B7" />

                <rect x="560" y="752" width="160" height="16" fill="#B4AC9A" />
                <rect x="568" y="756" width="72" height="12" fill="#22D3EE" fillOpacity="0.35" />
                <rect x="648" y="756" width="64" height="12" fill="#12101A" />
                <text x="880" y="744" fill="#6B6B7B" fontFamily={MONO} fontSize="12" letterSpacing="2" textAnchor="middle">LOBBY</text>

                <rect x="56" y="104" width="304" height="60" fill="#12101A" fillOpacity="0.6" />
                <rect x="64" y="112" width="8" height="24" fill="#E879F9" />
                <text x="88" y="132" fill="#E879F9" fontFamily={MONO} fontSize="18" fontWeight="700" letterSpacing="3">01 COORDINATOR</text>
                <rect x="232" y="168" width="144" height="72" fill="#12101A" stroke="#CFC8B7" strokeWidth="4" />
                <rect x="376" y="176" width="8" height="72" fill="#8E8878" />
                <rect x="232" y="240" width="152" height="8" fill="#8E8878" />
                <rect x="244" y="180" width="88" height="12" fill="#E879F9" style={{ animation: "domScan 2.4s ease-in-out infinite" }} />
                <rect x="244" y="200" width="24" height="12" fill="#818CF8" />
                <rect x="276" y="200" width="24" height="12" fill="#22D3EE" />
                <rect x="308" y="200" width="24" height="12" fill="#4ADE80" />
                <rect x="244" y="220" width="112" height="8" fill="#3A3038" />
                <use href="#plant" x="320" y="304" />

                <rect x="400" y="104" width="304" height="60" fill="#12101A" fillOpacity="0.6" />
                <rect x="408" y="112" width="8" height="24" fill="#818CF8" fillOpacity="0.6" />
                <text x="432" y="132" fill="#818CF8" fontFamily={MONO} fontSize="18" fontWeight="700" letterSpacing="3">02 PLANNING</text>
                <g opacity="0.6">
                  <rect x="576" y="208" width="144" height="88" fill="#4A4252" />
                  <rect x="576" y="208" width="144" height="4" fill="#584F62" />
                  <rect x="576" y="296" width="144" height="16" fill="#332C3B" />
                  <rect x="720" y="212" width="8" height="100" fill="#292330" />
                  <rect x="576" y="312" width="152" height="4" fill="#1A171F" />
                  <use href="#chair" x="592" y="176" />
                  <use href="#chair" x="664" y="176" />
                  <use href="#chair" x="592" y="316" />
                  <use href="#chair" x="664" y="316" />
                  <rect x="600" y="232" width="72" height="12" fill="#818CF8" fillOpacity="0.5" />
                  <rect x="600" y="252" width="96" height="8" fill="#2A2328" />
                  <rect x="576" y="336" width="144" height="14" fill="#B4AC9A" fillOpacity="0.4" />
                </g>

                <rect x="792" y="104" width="328" height="60" fill="#12101A" fillOpacity="0.6" />
                <rect x="800" y="112" width="8" height="24" fill="#4ADE80" />
                <text x="824" y="132" fill="#4ADE80" fontFamily={MONO} fontSize="18" fontWeight="700" letterSpacing="3">04 APPLICATION</text>
                <rect x="984" y="176" width="248" height="152" fill="#12101A" stroke="#CFC8B7" strokeWidth="4" />
                <rect x="984" y="328" width="256" height="8" fill="#8E8878" />
                <rect x="1232" y="184" width="8" height="152" fill="#8E8878" />
                <rect x="996" y="188" width="224" height="20" fill="#1B1922" />
                <rect x="1004" y="194" width="8" height="8" fill="#4ADE80" />
                <rect x="1020" y="194" width="8" height="8" fill="#3A3038" />
                <rect x="1036" y="194" width="8" height="8" fill="#3A3038" />
                <rect x="996" y="220" width="120" height="24" fill="#4ADE80" fillOpacity="0.85" />
                <rect x="996" y="254" width="176" height="10" fill="#3A3038" />
                <rect x="996" y="272" width="136" height="10" fill="#3A3038" />
                <rect x="996" y="292" width="88" height="12" fill="#4ADE80" style={{ animation: "domScan 1.8s ease-in-out infinite" }} />

                <rect x="56" y="392" width="424" height="60" fill="#12101A" fillOpacity="0.6" />
                <rect x="64" y="400" width="8" height="24" fill="#22D3EE" />
                <text x="88" y="420" fill="#22D3EE" fontFamily={MONO} fontSize="18" fontWeight="700" letterSpacing="3">03 CODING</text>
                <use href="#plant" x="1000" y="352" />

                <rect x="488" y="612" width="40" height="24" fill="#CFC8B7" />
                <rect x="528" y="616" width="8" height="24" fill="#8E8878" />
                <rect x="496" y="620" width="24" height="8" fill="#12101A" />
                <rect x="480" y="620" width="8" height="8" fill="#FBBF24" fillOpacity="0.8" />
                <rect x="472" y="636" width="72" height="36" fill="#4A4252" />
                <rect x="472" y="636" width="72" height="4" fill="#584F62" />
                <rect x="472" y="672" width="72" height="16" fill="#332C3B" />
                <rect x="544" y="640" width="8" height="48" fill="#292330" />
                <rect x="472" y="688" width="80" height="4" fill="#1A171F" />

                <rect x="792" y="416" width="328" height="60" fill="#12101A" fillOpacity="0.6" />
                <rect x="800" y="424" width="8" height="24" fill="#C084FC" fillOpacity="0.6" />
                <text x="824" y="444" fill="#C084FC" fontFamily={MONO} fontSize="18" fontWeight="700" letterSpacing="3">05 SUB-AGENTS</text>
                <rect x="1128" y="680" width="80" height="12" fill="#4A4252" />
                <rect x="1128" y="692" width="80" height="60" fill="#2A2328" stroke="#3A3441" strokeWidth="2" />
                <rect x="1208" y="684" width="8" height="68" fill="#1F1B25" />
                <rect x="1140" y="702" width="52" height="8" fill="#22D3EE" fillOpacity="0.5" />
                <rect x="1140" y="718" width="52" height="8" fill="#3A3038" />
                <rect x="1140" y="734" width="52" height="8" fill="#3A3038" />
                <rect x="1128" y="752" width="88" height="4" fill="#1A171F" />

                {model.freeDesks.map((d, i) => (
                  <use key={`fd${i}`} href="#deskEmpty" x={d.x} y={d.y} opacity="0.5" />
                ))}

                {geoms.map(({ a, g }) => (
                  <g key={a.id} onClick={() => props.onSelect(a.id)} style={{ cursor: "pointer" }}>
                    <use href="#desk" x={g.deskX} y={g.deskY} style={{ color: g.color }} />
                    <use href="#agBody" x={g.agX} y={g.agY} style={{ color: g.color }} opacity={g.opacity} />
                    <use href="#armL" x={g.agX} y={g.agY} style={{ color: g.color, ...(g.armAnimL || {}) }} opacity={g.opacity} />
                    <use href="#armR" x={g.agX} y={g.agY} style={{ color: g.color, ...(g.armAnimR || {}) }} opacity={g.opacity} />
                    {g.isBusy && <use href="#busy" x={g.cueX} y={g.cueY} style={{ color: g.color }} />}
                    {g.isAwait && <use href="#await" x={g.cueX} y={g.cueYBig} />}
                    {g.isSpeak && <use href="#speak" x={g.cueX} y={g.cueYBig} />}
                    {g.selected && <rect x={g.ringX} y={g.ringY} width="80" height="112" fill="none" stroke={g.color} strokeWidth="4" />}
                  </g>
                ))}
              </svg>

              {/* zone-count + name-plate overlay */}
              <div style={{ position: "absolute", inset: 0, containerType: "size", pointerEvents: "none" }}>
                {model.zoneCounts.map((z) => (
                  <div key={z.key} style={{ position: "absolute", left: z.left, top: z.top, fontSize: "1.05cqw", letterSpacing: "0.08cqw", color: "#6B6B7B", whiteSpace: "nowrap" }}>{z.text}</div>
                ))}
                {geoms.map(({ a, g }) => (
                  <div
                    key={a.id}
                    onClick={() => props.onSelect(a.id)}
                    style={{ position: "absolute", left: g.labelLeft, top: g.labelTop, transform: "translate(-50%, -100%)", background: "#12101A", border: `0.18cqw solid ${g.plateStroke}`, padding: "0.5cqw 0.7cqw", whiteSpace: "nowrap", pointerEvents: "auto", cursor: "pointer", display: "flex", flexDirection: "column", gap: "0.25cqw" }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5cqw" }}>
                      <span style={{ width: "0.75cqw", height: "0.75cqw", background: g.stateColor }} />
                      <span style={{ fontSize: "1cqw", letterSpacing: "0.12cqw", color: g.color }}>{g.name}</span>
                    </div>
                    <span style={{ fontSize: "1.2cqw", letterSpacing: "0.06cqw", color: "#C9C9D6" }}>{g.short}</span>
                  </div>
                ))}
              </div>

              {/* selection detail popup */}
              {sel && (
                <div style={{ position: "absolute", right: 12, bottom: 12, width: "min(320px, 46%)", minWidth: 220, maxHeight: "calc(100% - 24px)", overflowY: "auto", background: "#101017", border: "2px solid #2A2A38", boxShadow: "0 12px 32px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderBottom: "2px solid #2A2A38", gap: 8 }}>
                    <span style={{ fontSize: 13, letterSpacing: 2, color: sel.color }}>{sel.name}</span>
                    <span style={{ fontSize: 10, letterSpacing: 1, color: "#6B6B7B" }}>{ZONES[sel.zone as ZoneName].label}</span>
                    <button type="button" onClick={props.onClose} style={{ fontFamily: "inherit", fontSize: 11, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer", padding: "0 2px" }}>✕</button>
                  </div>
                  <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 10, height: 10, background: stateColor(sel) }} />
                      <span style={{ fontSize: 10, letterSpacing: 2, color: stateColor(sel) }}>{sel.state.toUpperCase()}</span>
                      <span style={{ fontSize: 10, letterSpacing: 1, color: "#6B6B7B", marginLeft: "auto" }}>{sel.id}</span>
                    </div>
                    <div style={{ fontSize: 12, lineHeight: 1.6, color: "#C9C9D6", background: "#15151C", border: "2px solid #2A2A38", padding: 10, textWrap: "pretty" }}>{sel.action}</div>
                    <div style={{ fontSize: 10, letterSpacing: 2, color: "#6B6B7B" }}>THINKING</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 132, overflowY: "auto" }}>
                      {sel.thinking.map((line, i) => (
                        <div key={i} style={{ fontSize: 11, lineHeight: 1.5, color: "#6B6B7B", textWrap: "pretty" }}>{line}</div>
                      ))}
                    </div>
                    {sel.state === "awaiting" && (
                      <div style={{ display: "flex", gap: 8 }}>
                        <button type="button" onClick={props.onApprove} style={{ fontFamily: "inherit", fontSize: 11, letterSpacing: 1, background: "#FBBF24", color: "#0D0D12", border: 0, padding: "8px 12px", cursor: "pointer", flex: 1 }}>APPROVE</button>
                        <button type="button" onClick={props.onDeny} style={{ fontFamily: "inherit", fontSize: 11, letterSpacing: 1, background: "#101017", color: "#C9C9D6", border: "2px solid #2A2A38", padding: "6px 12px", cursor: "pointer", flex: 1 }}>DENY</button>
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8 }}>
                      <input type="text" value={props.steer} onChange={(e) => props.onSteerDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") props.onSteer(); }} placeholder="steer this agent…" style={{ flex: 1, minWidth: 0, fontSize: 11, color: "#C9C9D6", background: "#15151C", border: "2px solid #2A2A38", padding: "7px 8px", outline: "none", fontFamily: MONO }} />
                      <button type="button" onClick={props.onSteer} style={{ fontFamily: "inherit", fontSize: 10, letterSpacing: 1, background: "#22D3EE", color: "#0D0D12", border: 0, padding: "7px 10px", cursor: "pointer" }}>STEER</button>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="button" onClick={props.onToggleIdle} style={{ fontFamily: "inherit", fontSize: 10, letterSpacing: 1, background: "#101017", color: "#C9C9D6", border: "2px solid #2A2A38", padding: "6px 10px", cursor: "pointer", flex: 1 }}>{sel.state === "idle" ? "WAKE" : "PARK"}</button>
                      <button type="button" onClick={props.onDismiss} style={{ fontFamily: "inherit", fontSize: 10, letterSpacing: 1, background: "#101017", color: "#E879F9", border: "2px solid #2A2A38", padding: "6px 10px", cursor: "pointer", flex: 1 }}>DISMISS</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ---- right column ---- */}
        <div style={{ flex: "1 1 320px", minWidth: "min(100%, 300px)", maxWidth: "100%", display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ background: "#15151C", border: "2px solid #2A2A38", padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 10, letterSpacing: 2, color: "#6B6B7B" }}>ROSTER</div>
            {allAgents.map((a) => (
              <div key={a.id} onClick={() => props.onSelect(a.id)} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, padding: "6px 8px", cursor: "pointer", borderLeft: `4px solid ${a.color}`, background: a.id === selectedId ? "#1B1B24" : "transparent" }}>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}  {a.action.length > 18 ? a.action.slice(0, 17) + "…" : a.action}</span>
                <span style={{ fontSize: 10, letterSpacing: 1, color: stateColor(a) }}>{a.state.toUpperCase()}</span>
              </div>
            ))}
          </div>

          <div style={{ background: "#15151C", border: "2px solid #2A2A38", display: "flex", flexDirection: "column", height: 520 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: "2px solid #2A2A38" }}>
              <span style={{ fontSize: 10, letterSpacing: 2, color: "#6B6B7B" }}>CHAT · {props.chatTarget}</span>
              <span style={{ fontSize: 10, letterSpacing: 1, color: "#22D3EE" }}>LIVE</span>
            </div>
            <div style={{ flex: "1 1 auto", overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 14, minHeight: 0 }}>
              {props.chat.map((m) => (
                <div key={m.key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10, letterSpacing: 1 }}>
                    <span style={{ width: 10, height: 10, background: m.color }} />
                    <span style={{ color: m.color }}>{m.from}</span>
                    <span style={{ color: "#6B6B7B" }}>{m.time}</span>
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.6, color: "#C9C9D6", background: "#101017", border: `2px solid ${m.border}`, padding: 10, textWrap: "pretty" }}>{m.text}</div>
                </div>
              ))}
            </div>
            <div style={{ borderTop: "2px solid #2A2A38", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {props.mentions.map((t) => (
                  <span key={t.key} onClick={t.onClick} style={{ fontSize: 10, letterSpacing: 1, color: t.color, border: `2px solid ${t.border}`, padding: "3px 8px", cursor: "pointer" }}>{t.label}</span>
                ))}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#101017", border: "2px solid #2A2A38", padding: "8px 10px" }}>
                <span style={{ color: "#22D3EE", fontSize: 13 }}>&gt;</span>
                <input type="text" value={props.draft} onChange={(e) => props.onDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") props.onSend(); }} placeholder="message the floor…" style={{ flex: 1, minWidth: 0, fontSize: 12, color: "#C9C9D6", background: "transparent", border: 0, outline: "none", padding: "2px 0", fontFamily: MONO }} />
                <span style={{ width: 8, height: 16, background: "#22D3EE", animation: "domCaret 1s steps(1) infinite" }} />
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontSize: 10, letterSpacing: 1, color: "#6B6B7B" }}>{props.ctxLine}</span>
                <button type="button" onClick={props.onSend} style={{ fontFamily: "inherit", fontSize: 11, letterSpacing: 2, background: "#22D3EE", color: "#0D0D12", border: 0, padding: "8px 18px", cursor: "pointer" }}>SEND</button>
              </div>
            </div>
          </div>

          <div style={{ background: "#15151C", border: "2px solid #2A2A38", padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 10, letterSpacing: 2, color: "#6B6B7B" }}>DRIVE IT FROM CODE · window.domOffice</div>
            <div style={{ fontSize: 11, lineHeight: 1.7, color: "#6B6B7B" }}>add · update · think · remove · list · say</div>
            <div style={{ fontSize: 10, lineHeight: 1.6, color: "#4A4A58", textWrap: "pretty" }}>Live-driven by the event bus; window.domOffice adds a debug overlay on top. zones: coordinator · planning · coding · application · subagents — states: busy · awaiting · speaking · idle.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function stateColor(a: { state: string }): string {
  return STATE_COLOR_MAP[a.state] || "#6B6B7B";
}
const STATE_COLOR_MAP: Record<string, string> = { busy: "#22D3EE", awaiting: "#FBBF24", speaking: "#E879F9", idle: "#6B6B7B" };

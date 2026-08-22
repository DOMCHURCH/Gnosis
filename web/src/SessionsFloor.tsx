import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SessionsModel } from "./sessions";
import { ZONE_BY_ID } from "./sessions.js";
import type { CommandItem } from "./store";
import type { ChatSegment, ToolPayload } from "./chatgroups";
import { DiffView, FileView } from "./DiffView";

export interface ChatMsg { key: string; from: string; color: string; time: string; kind: string; segments: ChatSegment[]; border: string; isApproval: boolean; permId?: string; resolved?: string; tool?: ToolPayload; }
export interface SelDetail {
  id: string; name: string; zone: string; color: string; stateColor: string; state: string;
  action: string; output: string[]; thinking: string[]; awaiting: boolean;
}

export interface SessionsProps {
  model: SessionsModel;
  chat: ChatMsg[];
  sel: SelDetail | null;
  draft: string;
  steer: string;
  commands: CommandItem[];
  activeTabId: number | null;
  requestFiles: (tabId: number, query: string) => Promise<string[]>;
  onSelectFloor: (id: number) => void;
  onAddFloor: () => void;
  onSelectFig: (id: string | null) => void;
  onClose: () => void;
  onApprove: () => void;
  onDeny: () => void;
  onDismiss: () => void;
  onSteer: () => void;
  onSteerDraft: (v: string) => void;
  onDraft: (v: string) => void;
  onSend: () => void;
  onApproveMsg: (permId?: string) => void;
  onDenyMsg: (permId?: string) => void;
  /** The goal bar, rendered directly above the chat rail. */
  goalBar?: ReactNode;
  /** Optional collapsible panel rendered at the far left (the File Browser). */
  leftPanel?: ReactNode;
  /** Optional collapsible panel rendered at the far right (the Background jobs panel). */
  rightPanel?: ReactNode;
}

const MONO = "'JetBrains Mono', ui-monospace, monospace";
const ZBTN = { fontFamily: "inherit", fontSize: 10, letterSpacing: 1, background: "#101017", color: "#C9C9D6", border: "2px solid #2A2A38", padding: "5px 10px", cursor: "pointer", minWidth: 30 } as const;

// Live viewport width so we can branch layout (inline styles → no CSS media query).
// Returns 0 until mounted so SSR/first paint doesn't guess wrong.
function useViewport(): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

export function SessionsFloor(props: SessionsProps) {
  const { model, sel } = props;
  const L = model.layout;
  const [zoom, setZoom] = useState(1); // 1 = fit; > 1 scrolls
  const vw = useViewport();
  const mobile = vw > 0 && vw < 640; // phones: floor hidden, chat full-width, bottom tab bar
  const narrow = vw > 0 && vw < 900; // tablets: floor collapses to a zone strip
  const [floorOpen, setFloorOpen] = useState(false); // narrow: expand the full floor
  const [filesOpen, setFilesOpen] = useState(false);  // narrow/mobile: file browser bottom sheet
  const [jobsOpen, setJobsOpen] = useState(false);    // narrow/mobile: background jobs bottom sheet

  return (
    <div style={{ minHeight: "100vh", background: "#0D0D12", color: "#C9C9D6", fontFamily: MONO, padding: 24, boxSizing: "border-box", display: "flex", justifyContent: "center" }}>
      <div style={{ width: "100%", maxWidth: 1560, display: "flex", flexDirection: "column", gap: 16 }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24, borderBottom: "2px solid #2A2A38", paddingBottom: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
            <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: 4 }}>dom</span>
            <span style={{ fontSize: 11, color: "#6B6B7B", letterSpacing: 2, whiteSpace: "nowrap" }}>TERMINAL SESSIONS · ONE FLOOR EACH</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 20, fontSize: 11, letterSpacing: 2, color: "#6B6B7B" }}>
            <span style={{ color: "#FBBF24", whiteSpace: "nowrap" }}>{model.awaitingLine}</span>
            <span style={{ whiteSpace: "nowrap" }}>{model.globalLine}</span>
            {model.costLine && <span style={{ color: "#22D3EE", whiteSpace: "nowrap" }}>{model.costLine}</span>}
          </div>
        </div>

        <div style={{ display: "flex", gap: 20, alignItems: "stretch", flexWrap: "wrap" }}>
          {/* File Browser: inline when there's room; a bottom sheet on narrow/mobile. */}
          {!narrow && props.leftPanel}
          <div style={{ flex: "1 1 640px", minWidth: 0, display: mobile ? "none" : "flex", gap: 16, alignItems: "stretch" }}>
            {/* left rail — session selector (becomes a bottom tab bar on mobile) */}
            <div style={{ flex: "0 0 64px", width: 64, display: "flex", flexDirection: "column", gap: 8 }}>
              {model.floorTabs.map((f) => (
                <button key={f.key} type="button" onClick={() => props.onSelectFloor(f.id)} style={{ fontFamily: "inherit", width: 64, height: 62, background: f.bg, color: f.fg, border: `2px solid ${f.border}`, borderLeft: `5px solid ${f.accent}`, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5, padding: 0 }}>
                  <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: 1 }}>{f.num}</span>
                  <span style={{ width: 8, height: 8, background: f.dot, ...(f.dotAnim || {}) }} />
                </button>
              ))}
              <button type="button" onClick={props.onAddFloor} style={{ fontFamily: "inherit", width: 64, height: 40, background: "#101017", color: "#6B6B7B", border: "2px dashed #2A2A38", cursor: "pointer", fontSize: 15 }}>+</button>
              <div style={{ fontSize: 8, letterSpacing: 1, color: "#4A4A58", textAlign: "center", lineHeight: 1.5, paddingTop: 4 }}>CLI<br />WINDOWS</div>
            </div>

            {/* center column */}
            <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ background: "#15151C", border: "2px solid #2A2A38", borderLeft: `6px solid ${model.sessionAccent}`, padding: "12px 16px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: 3, whiteSpace: "nowrap" }}>{model.sessionTitle}</span>
                <span style={{ fontSize: 13, color: "#6B6B7B", letterSpacing: 1, flex: "1 1 200px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{model.sessionTask}</span>
                <span style={{ fontSize: 10, letterSpacing: 2, color: model.sessionStateColor, whiteSpace: "nowrap" }}>{model.sessionState}</span>
              </div>

              {narrow && !floorOpen && (
                <ZoneStrip zones={L.zoneLabels} onExpand={() => setFloorOpen(true)} />
              )}
              <div style={{ background: "#15151C", border: "2px solid #2A2A38", padding: 14, display: narrow && !floorOpen ? "none" : "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 10, letterSpacing: 2, color: "#6B6B7B" }}>OFFICE FLOOR · CLICK AN AGENT{narrow ? <button type="button" onClick={() => setFloorOpen(false)} style={{ ...ZBTN, marginLeft: 10, padding: "2px 8px" }}>▴ HIDE</button> : null}</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" onClick={() => setZoom((z) => Math.max(1, +(z - 0.25).toFixed(2)))} style={ZBTN}>−</button>
                    <button type="button" onClick={() => setZoom(1)} style={{ ...ZBTN, color: zoom === 1 ? "#22D3EE" : "#C9C9D6", borderColor: zoom === 1 ? "#22D3EE" : "#2A2A38" }}>FIT</button>
                    <button type="button" onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))} style={ZBTN}>+</button>
                  </div>
                </div>

                <div style={{ position: "relative" }}>
                  <div style={{ overflowX: zoom > 1 ? "auto" : "hidden", overflowY: "hidden" }}>
                    <div style={{ position: "relative", width: `${zoom * 100}%` }}>
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

                        <rect x="0" y="0" width="1440" height="900" fill="#12111A" />
                        <rect x="16" y="16" width="1408" height="868" fill="#CFC8B7" />
                        <rect x="32" y="32" width="1376" height="836" fill="url(#tile)" />

                        {L.zonePlates.map((z) => (
                          <rect key={z.key} x={z.x} y={z.y} width={z.w} height={z.h} fill={z.fill} fillOpacity={z.op} />
                        ))}
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

                        {L.freeDesks.map((d) => (
                          <use key={d.key} href="#deskEmpty" x={d.x} y={d.y} opacity="0.55" />
                        ))}

                        {L.placed.map((a) => (
                          <g key={a.key} onClick={() => props.onSelectFig(a.id)} style={{ cursor: "pointer" }}>
                            <use href="#desk" x={a.deskX} y={a.deskY} style={{ color: a.color }} />
                            <use href="#agBody" x={a.agX} y={a.agY} style={{ color: a.color }} opacity={a.opacity} />
                            <use href="#armL" x={a.agX} y={a.agY} style={{ color: a.color, ...(a.armL || {}) }} opacity={a.opacity} />
                            <use href="#armR" x={a.agX} y={a.agY} style={{ color: a.color, ...(a.armR || {}) }} opacity={a.opacity} />
                            {a.isThinking && <use href="#busy" x={a.cueX} y={a.cueY} style={{ color: a.color }} />}
                            {a.isAwaiting && <use href="#await" x={a.cueX} y={a.cueYBig} />}
                            {a.isSpeaking && <use href="#speak" x={a.cueX} y={a.cueYBig} />}
                            {a.selected && <rect x={a.ringX} y={a.ringY} width="80" height="112" fill="none" stroke={a.color} strokeWidth="4" />}
                          </g>
                        ))}
                      </svg>

                      <div style={{ position: "absolute", inset: 0, containerType: "size", pointerEvents: "none" }}>
                        {L.zoneLabels.map((z) => (
                          <div key={z.key} style={{ position: "absolute", left: z.left, top: z.top, display: "flex", flexDirection: "column", gap: "0.3cqw", whiteSpace: "nowrap" }}>
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
                      </div>
                    </div>
                  </div>

                  {sel && (
                    <div style={{ position: "absolute", right: 12, bottom: 12, width: "min(330px, 92%)", maxHeight: "92%", overflowY: "auto", background: "#101017", border: "2px solid #2A2A38", boxShadow: "0 14px 34px rgba(0,0,0,0.7)", display: "flex", flexDirection: "column" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 11px", borderBottom: "2px solid #2A2A38" }}>
                        <span style={{ width: 8, height: 8, background: sel.stateColor }} />
                        <span style={{ fontSize: 12, letterSpacing: 2, color: sel.color }}>{sel.name}</span>
                        <span style={{ fontSize: 9, letterSpacing: 1, color: "#6B6B7B", marginLeft: "auto" }}>{sel.zone}</span>
                        <button type="button" onClick={props.onClose} style={{ fontFamily: "inherit", fontSize: 11, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer" }}>✕</button>
                      </div>
                      <div style={{ padding: 11, display: "flex", flexDirection: "column", gap: 9 }}>
                        <div style={{ fontSize: 11, lineHeight: 1.6, color: "#C9C9D6", background: "#15151C", border: "2px solid #2A2A38", padding: 8, textWrap: "pretty" }}>{sel.action}</div>
                        <div style={{ fontSize: 9, letterSpacing: 2, color: "#6B6B7B" }}>RECENT OUTPUT</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 3, background: "#0B0B10", border: "2px solid #2A2A38", padding: 8, maxHeight: 88, overflowY: "auto" }}>
                          {(sel.output.length ? sel.output : ["no output yet"]).map((o, i) => (
                            <div key={i} style={{ fontSize: 10, lineHeight: 1.5, color: "#6B6B7B", whiteSpace: "pre-wrap" }}>{o}</div>
                          ))}
                        </div>
                        <div style={{ fontSize: 9, letterSpacing: 2, color: "#6B6B7B" }}>THINKING</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 88, overflowY: "auto" }}>
                          {(sel.thinking.length ? sel.thinking : ["no thinking recorded"]).map((t, i) => (
                            <div key={i} style={{ fontSize: 10, lineHeight: 1.5, color: "#8A8A9B", textWrap: "pretty" }}>{t}</div>
                          ))}
                        </div>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button type="button" onClick={props.onApprove} style={{ fontFamily: "inherit", fontSize: 10, letterSpacing: 1, background: sel.awaiting ? "#FBBF24" : "#15151C", color: sel.awaiting ? "#0D0D12" : "#6B6B7B", border: 0, padding: "7px 8px", cursor: "pointer", flex: 1 }}>APPROVE</button>
                          <button type="button" onClick={props.onDeny} style={{ fontFamily: "inherit", fontSize: 10, letterSpacing: 1, background: "#15151C", color: "#C9C9D6", border: "2px solid #2A2A38", padding: "5px 8px", cursor: "pointer", flex: 1 }}>DENY</button>
                          <button type="button" onClick={props.onDismiss} style={{ fontFamily: "inherit", fontSize: 10, letterSpacing: 1, background: "#15151C", color: "#E879F9", border: "2px solid #2A2A38", padding: "5px 8px", cursor: "pointer", flex: 1 }}>DISMISS</button>
                        </div>
                        <div style={{ display: "flex", gap: 6 }}>
                          <input type="text" value={props.steer} onChange={(e) => props.onSteerDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") props.onSteer(); }} placeholder="steer this agent…" style={{ flex: 1, minWidth: 0, fontSize: 10, color: "#C9C9D6", background: "#15151C", border: "2px solid #2A2A38", padding: "6px 7px", outline: "none", fontFamily: MONO }} />
                          <button type="button" onClick={props.onSteer} style={{ fontFamily: "inherit", fontSize: 10, letterSpacing: 1, background: "#22D3EE", color: "#0D0D12", border: 0, padding: "6px 9px", cursor: "pointer" }}>STEER</button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* right column — roster + chat */}
          <div style={{ flex: "1 1 320px", minWidth: "min(100%, 300px)", display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ background: "#15151C", border: "2px solid #2A2A38", display: "flex", flexDirection: "column", maxHeight: 320 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderBottom: "2px solid #2A2A38" }}>
                <span style={{ fontSize: 9, letterSpacing: 2, color: "#6B6B7B" }}>WHO IS WORKING</span>
                <span style={{ fontSize: 9, letterSpacing: 1, color: model.offFloorColor }}>{model.offFloorLine}</span>
              </div>
              <div style={{ overflowY: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                {L.roster.map((r) => (
                  <div key={r.key} onClick={() => props.onSelectFig(r.id)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 7px", cursor: "pointer", borderLeft: `3px solid ${r.accent}`, background: r.bg, opacity: r.opacity }}>
                    <span style={{ fontSize: 11, letterSpacing: 1, color: r.color, whiteSpace: "nowrap" }}>{r.name}</span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 10, color: "#6B6B7B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.action}</span>
                    <span style={{ fontSize: 9, letterSpacing: 1, color: r.stateColor, whiteSpace: "nowrap" }}>{r.tag}</span>
                  </div>
                ))}
              </div>
            </div>

            {props.goalBar}

            <div style={{ background: "#15151C", border: "2px solid #2A2A38", flex: "1 1 auto", minHeight: 340, display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderBottom: "2px solid #2A2A38" }}>
                <span style={{ fontSize: 9, letterSpacing: 2, color: "#6B6B7B" }}>{model.chatHeader}</span>
                <span style={{ fontSize: 9, letterSpacing: 1, color: "#22D3EE" }}>LIVE</span>
              </div>
              <div style={{ flex: "1 1 auto", overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
                {props.chat.map((m) => {
                  if (m.kind === "tool" && m.tool) return <ToolLine key={m.key} tool={m.tool} />;
                  const resolvedColor = m.resolved ? (m.resolved === "no" ? "#F87171" : "#4ADE80") : null;
                  return (
                    <div key={m.key} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 9, letterSpacing: 1 }}>
                        <span style={{ width: 8, height: 8, background: m.color }} />
                        <span style={{ color: m.color }}>{m.from}</span>
                        <span style={{ color: "#6B6B7B" }}>{m.time}</span>
                      </div>
                      <div style={{ fontSize: 11, lineHeight: 1.6, color: resolvedColor ?? "#C9C9D6", background: "#101017", border: `2px solid ${m.border}`, padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                        {m.segments.map((s, i) => s.type === "code"
                          ? <CodeBlock key={i} lang={s.lang} text={s.text} />
                          : <div key={i} style={{ textWrap: "pretty", whiteSpace: "pre-wrap", color: resolvedColor ?? undefined }}>{s.text}</div>)}
                      </div>
                      {m.isApproval && (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button type="button" onClick={() => props.onApproveMsg(m.permId)} style={{ fontFamily: "inherit", fontSize: 10, letterSpacing: 1, background: "#FBBF24", color: "#0D0D12", border: 0, padding: "6px 12px", cursor: "pointer" }}>APPROVE</button>
                          <button type="button" onClick={() => props.onDenyMsg(m.permId)} style={{ fontFamily: "inherit", fontSize: 10, letterSpacing: 1, background: "#101017", color: "#C9C9D6", border: "2px solid #2A2A38", padding: "4px 12px", cursor: "pointer" }}>DENY</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div style={{ borderTop: "2px solid #2A2A38", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
                <ChatInput value={props.draft} onChange={props.onDraft} onSubmit={props.onSend} commands={props.commands} requestFiles={props.requestFiles} tabId={props.activeTabId} />
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontSize: 9, letterSpacing: 1, color: "#6B6B7B" }}>{model.ctxLine}</span>
                  <button type="button" onClick={props.onSend} style={{ fontFamily: "inherit", fontSize: 10, letterSpacing: 2, background: "#22D3EE", color: "#0D0D12", border: 0, padding: "7px 16px", cursor: "pointer" }}>SEND</button>
                </div>
              </div>
            </div>
          </div>
          {/* Background jobs: inline when there's room; a bottom sheet on narrow/mobile. */}
          {!narrow && props.rightPanel}
        </div>

        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 9, letterSpacing: 1, color: "#4A4A58", borderTop: "2px solid #2A2A38", paddingTop: 10 }}>
          <span>window.domOffice · add · update · think · remove · list · say · setFloor · addFloor · onUserMessage · onApproval</span>
          <span>capacity 1 · 2 · 8 · 2 · 6 — extras stay in WHO IS WORKING as OFF-FLOOR</span>
        </div>

        {mobile && <div style={{ height: 56 }} />}{/* spacer so the fixed bar doesn't cover content */}
      </div>

      {/* Narrow/mobile: a FILES button that opens the file browser as a bottom sheet. */}
      {narrow && props.leftPanel && (
        <button type="button" onClick={() => setFilesOpen(true)} title="files" style={{ position: "fixed", right: 14, bottom: mobile ? 68 : 14, zIndex: 30, fontFamily: MONO, fontSize: 11, letterSpacing: 1, background: "#101017", color: "#22D3EE", border: "2px solid #2A2A38", padding: "8px 12px", cursor: "pointer" }}>≡ FILES</button>
      )}
      {narrow && filesOpen && props.leftPanel && (
        <div onClick={() => setFilesOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(5,5,8,0.72)", zIndex: 45, display: "flex", alignItems: "flex-end" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxHeight: "70vh", display: "flex", flexDirection: "column", background: "#0D0D12", borderTop: "2px solid #2A2A38" }}>
            <div style={{ display: "flex", justifyContent: "flex-end", padding: 8 }}>
              <button type="button" onClick={() => setFilesOpen(false)} style={{ fontFamily: MONO, fontSize: 12, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer" }}>✕ close</button>
            </div>
            <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex", padding: "0 8px 8px" }}>{props.leftPanel}</div>
          </div>
        </div>
      )}

      {/* Narrow/mobile: a JOBS button that opens the background panel as a bottom sheet. */}
      {narrow && props.rightPanel && (
        <button type="button" onClick={() => setJobsOpen(true)} title="background jobs" style={{ position: "fixed", right: 14, bottom: mobile ? 112 : 58, zIndex: 30, fontFamily: MONO, fontSize: 11, letterSpacing: 1, background: "#101017", color: "#4ADE80", border: "2px solid #2A2A38", padding: "8px 12px", cursor: "pointer" }}>⎈ JOBS</button>
      )}
      {narrow && jobsOpen && props.rightPanel && (
        <div onClick={() => setJobsOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(5,5,8,0.72)", zIndex: 45, display: "flex", alignItems: "flex-end" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxHeight: "70vh", display: "flex", flexDirection: "column", background: "#0D0D12", borderTop: "2px solid #2A2A38" }}>
            <div style={{ display: "flex", justifyContent: "flex-end", padding: 8 }}>
              <button type="button" onClick={() => setJobsOpen(false)} style={{ fontFamily: MONO, fontSize: 12, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer" }}>✕ close</button>
            </div>
            <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex", padding: "0 8px 8px" }}>{props.rightPanel}</div>
          </div>
        </div>
      )}

      {/* Mobile: session selector as a fixed bottom tab bar with per-session activity dots. */}
      {mobile && (
        <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 30, display: "flex", gap: 6, padding: "8px 10px", background: "#0D0D12", borderTop: "2px solid #2A2A38", overflowX: "auto" }}>
          {model.floorTabs.map((f) => (
            <button key={f.key} type="button" onClick={() => props.onSelectFloor(f.id)} style={{ fontFamily: MONO, flex: "0 0 auto", minWidth: 44, height: 40, background: f.bg, color: f.fg, border: `2px solid ${f.border}`, borderBottom: `4px solid ${f.accent}`, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, padding: "0 8px" }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{f.num}</span>
              <span style={{ width: 7, height: 7, background: f.dot, ...(f.dotAnim || {}) }} />
            </button>
          ))}
          <button type="button" onClick={props.onAddFloor} style={{ fontFamily: MONO, flex: "0 0 auto", width: 40, height: 40, background: "#101017", color: "#6B6B7B", border: "2px dashed #2A2A38", cursor: "pointer", fontSize: 15 }}>+</button>
        </div>
      )}
    </div>
  );
}

// Narrow-screen replacement for the office floor: a compact strip of zone name +
// agent-count chips. Tapping any chip expands the full floor (one tap in, HIDE out).
function ZoneStrip(props: { zones: { key: string; name: string; count: string; accent: string; countColor: string }[]; onExpand: () => void }) {
  return (
    <div style={{ background: "#15151C", border: "2px solid #2A2A38", padding: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
      <div style={{ flex: "1 1 100%", fontSize: 10, letterSpacing: 2, color: "#6B6B7B", marginBottom: 2 }}>OFFICE FLOOR · TAP A ZONE TO EXPAND</div>
      {props.zones.map((z) => (
        <button key={z.key} type="button" onClick={props.onExpand} style={{ fontFamily: MONO, textAlign: "left", background: "#101017", border: "2px solid #2A2A38", borderLeft: `4px solid ${z.accent}`, padding: "7px 10px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 3, minWidth: 96 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: z.accent }}>{z.name}</span>
          <span style={{ fontSize: 10, color: z.countColor }}>{z.count}</span>
        </button>
      ))}
    </div>
  );
}

// A fenced code block: monospace, in its own bordered box, code kept verbatim
// (never reflowed as prose). The dim ─── header echoes the TUI's fence rule.
function CodeBlock(props: { lang?: string; text: string }) {
  return (
    <div style={{ background: "#0B0B10", border: "1px solid #2A2A38", borderLeft: "3px solid #22D3EE", padding: "6px 8px", overflowX: "auto" }}>
      <div style={{ fontSize: 9, letterSpacing: 1, color: "#4A4A58", marginBottom: 4, whiteSpace: "nowrap" }}>─── {props.lang || "code"}</div>
      <pre style={{ margin: 0, fontFamily: MONO, fontSize: 11, lineHeight: 1.5, color: "#C9C9D6", whiteSpace: "pre" }}>{props.text}</pre>
    </div>
  );
}

// A tool call in the chat rail: the compact TUI form — ● Write(greet.py) with a
// ⎿ one-line summary — that expands on click to the full result (file content for
// write, the diff for edit, the full output for bash). Collapsed by default.
function ToolLine(props: { tool: ToolPayload }) {
  const t = props.tool;
  const [open, setOpen] = useState(false);
  const dot = t.ok ? "#22D3EE" : "#F87171";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div onClick={() => setOpen((o) => !o)} title="click to expand" style={{ cursor: "pointer", fontFamily: MONO, fontSize: 11, lineHeight: 1.5 }}>
        <div style={{ color: "#C9C9D6", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <span style={{ color: dot }}>●</span> {t.tool}({t.primary}{t.secondary})
        </div>
        <div style={{ color: "#6B6B7B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          ⎿ {t.summary || (t.ok ? "done" : "error")} <span style={{ color: "#4A4A58" }}>{open ? "▾" : "▸"}</span>
        </div>
      </div>
      {open && t.detail ? (
        /edit/i.test(t.tool) ? <DiffView detail={t.detail} path={t.primary} />
          : /write/i.test(t.tool) ? <FileView detail={t.detail} path={t.primary} />
          : <pre style={{ margin: 0, marginLeft: 12, padding: "6px 8px", background: "#0B0B10", border: "1px solid #2A2A38", borderLeft: `3px solid ${dot}`, fontFamily: MONO, fontSize: 11, lineHeight: 1.5, color: "#C9C9D6", whiteSpace: "pre-wrap", maxHeight: 320, overflowY: "auto" }}>{t.detail}</pre>
      ) : null}
    </div>
  );
}

// re-export so App can resolve a figure's zone label without importing sessions.js twice
export function zoneLabel(zoneId: string): string {
  return (ZONE_BY_ID as Record<string, { name: string }>)[zoneId]?.name ?? "";
}

// Chat input with the SAME slash-command list the TUI shows (filtered as you type,
// arrows to select, Enter/Tab to complete) plus @-file autocomplete.
function ChatInput(props: { value: string; onChange: (v: string) => void; onSubmit: () => void; commands: CommandItem[]; requestFiles: (t: number, q: string) => Promise<string[]>; tabId: number | null }) {
  const { value } = props;
  const ref = useRef<HTMLInputElement>(null);
  const [pick, setPick] = useState(0);
  const [files, setFiles] = useState<string[]>([]);

  const atMatch = /(^|\s)@(\S*)$/.exec(value);
  const cmdMode = value.startsWith("/") && !/\s/.test(value);
  const fileMode = !!atMatch && props.tabId != null;
  const query = fileMode ? atMatch![2]! : "";

  useEffect(() => {
    if (!fileMode || props.tabId == null) { setFiles([]); return; }
    let live = true;
    props.requestFiles(props.tabId, query).then((list) => { if (live) { setFiles(list.slice(0, 8)); setPick(0); } });
    return () => { live = false; };
  }, [fileMode, query, props.tabId]);

  const items: { label: string; hint?: string }[] = cmdMode
    ? props.commands.filter((c) => c.name.startsWith(value.toLowerCase())).slice(0, 8).map((c) => ({ label: c.name, hint: (c.args ? c.args + "  " : "") + c.desc }))
    : fileMode
      ? files.map((f) => ({ label: f }))
      : [];
  const open = items.length > 0;

  const complete = (label: string) => {
    if (cmdMode) props.onChange(label + " ");
    else if (atMatch) props.onChange(value.slice(0, atMatch.index) + atMatch[1] + "@" + label + " ");
    setPick(0);
    ref.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (open) {
      if (e.key === "ArrowDown") { e.preventDefault(); setPick((p) => (p + 1) % items.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setPick((p) => (p - 1 + items.length) % items.length); return; }
      if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); complete(items[pick]!.label); return; }
      if (e.key === "Escape") { setFiles([]); return; }
    }
    if (e.key === "Enter") props.onSubmit();
  };

  return (
    <div style={{ position: "relative" }}>
      {open && (
        <div style={{ position: "absolute", bottom: "calc(100% + 4px)", left: 0, right: 0, maxHeight: 220, overflowY: "auto", background: "#101017", border: "2px solid #2A2A38", boxShadow: "0 -8px 24px rgba(0,0,0,0.6)", zIndex: 5 }}>
          {items.map((it, i) => (
            <div key={it.label} onMouseDown={(e) => { e.preventDefault(); complete(it.label); }} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "6px 9px", cursor: "pointer", background: i === pick ? "#1D1D27" : "transparent" }}>
              <span style={{ fontSize: 11, color: "#22D3EE", whiteSpace: "nowrap" }}>{it.label}</span>
              {it.hint && <span style={{ fontSize: 10, color: "#6B6B7B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.hint}</span>}
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#101017", border: "2px solid #2A2A38", padding: "7px 9px" }}>
        <span style={{ color: "#22D3EE", fontSize: 12 }}>&gt;</span>
        <input ref={ref} type="text" value={value} onChange={(e) => props.onChange(e.target.value)} onKeyDown={onKeyDown} placeholder="message this session… (/ commands, @ files)" style={{ flex: 1, minWidth: 0, fontSize: 11, color: "#C9C9D6", background: "transparent", border: 0, outline: "none", fontFamily: MONO }} />
        <span style={{ width: 7, height: 14, background: "#22D3EE", animation: "domCaret 1s steps(1) infinite" }} />
      </div>
    </div>
  );
}

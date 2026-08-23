import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SessionsModel, ZoneId } from "./sessions";
import { ZONE_BY_ID } from "./sessions.js";
import type { CommandItem } from "./store";
import type { ChatSegment, ToolPayload } from "./chatgroups";
import { DiffView, FileView } from "./DiffView";
import { Minus, Plus, Maximize2, Minimize2, Paperclip, ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

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
  /** Click an empty desk (or a collapsed zone) to place a manual agent there. */
  onDeskClick: (zone: ZoneId, slot: number) => void;
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
  /** Files staged for the next message (name + mime only; bytes live in App). */
  attachments: { name: string; mime: string }[];
  /** Stage picked/dropped files (base64-encoded and gated by App). */
  onAddFiles: (files: File[]) => void;
  /** Remove a staged attachment by index. */
  onRemoveAttachment: (i: number) => void;
  /** Whether the active model accepts image / document input (gates the picker). */
  canImage: boolean;
  canDoc: boolean;
  /** When true, assistant messages show a "save to vault" button. */
  canSaveVault?: boolean;
  /** Save an assistant message's text to the vault (opens the filename/tags modal). */
  onSaveMsg?: (content: string) => void;
  /** The goal bar, rendered directly above the chat rail. */
  goalBar?: ReactNode;
  /** Optional collapsible panel rendered at the far left (the File Browser). */
  leftPanel?: ReactNode;
  /** Optional collapsible panel rendered at the far right (the Background jobs panel). */
  rightPanel?: ReactNode;
}

const MONO = "'JetBrains Mono', ui-monospace, monospace";

// Chat panel layout persists across the browser session (survives refresh).
const CHAT_H_KEY = "dom-chat-height";      // docked height in px (null = default)
const CHAT_DETACH_KEY = "dom-chat-detached";
const CHAT_FLOAT_KEY = "dom-chat-float";   // { x, y, w, h } when floating
const CHAT_MIN_H = 200;
const chatMaxH = () => Math.round((typeof window !== "undefined" ? window.innerHeight : 900) * 0.9);
const defaultChatH = () => Math.max(CHAT_MIN_H, Math.min(chatMaxH(), Math.round((typeof window !== "undefined" ? window.innerHeight : 900) * 0.6)));
function lsGet<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v == null ? fallback : (JSON.parse(v) as T); } catch { return fallback; }
}
function lsSet(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode / quota */ } }

// Floating-panel resize handles: cursor + absolute position per edge/corner.
type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const RESIZE_CURSOR: Record<Edge, string> = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" };
const RESIZE_POS: Record<Edge, React.CSSProperties> = {
  n: { top: -4, left: 8, right: 8, height: 8 },
  s: { bottom: -4, left: 8, right: 8, height: 8 },
  e: { top: 8, bottom: 8, right: -4, width: 8 },
  w: { top: 8, bottom: 8, left: -4, width: 8 },
  ne: { top: -4, right: -4, width: 14, height: 14 },
  nw: { top: -4, left: -4, width: 14, height: 14 },
  se: { bottom: -4, right: -4, width: 14, height: 14 },
  sw: { bottom: -4, left: -4, width: 14, height: 14 },
};
const EDGES: Edge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/** Flatten a chat message's segments back to markdown text (code segments re-fenced)
 * — the payload for "save to vault". */
function messageToText(m: ChatMsg): string {
  return m.segments
    .map((s) => (s.type === "code" ? "```" + (s.lang ?? "") + "\n" + s.text + "\n```" : s.text))
    .join("\n\n")
    .trim();
}

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

  // Chat panel: docked height (resizable), detach/float, floating rect. Persisted.
  const [chatHeight, setChatHeight] = useState<number | null>(() => lsGet<number | null>(CHAT_H_KEY, null));
  const [detached, setDetached] = useState<boolean>(() => lsGet<boolean>(CHAT_DETACH_KEY, false));
  const [floatRect, setFloatRect] = useState<{ x: number; y: number; w: number; h: number }>(() => lsGet(CHAT_FLOAT_KEY, { x: 140, y: 96, w: 460, h: 520 }));
  const [snapping, setSnapping] = useState(false); // brief animation when docking
  useEffect(() => { lsSet(CHAT_H_KEY, chatHeight); }, [chatHeight]);
  useEffect(() => { lsSet(CHAT_DETACH_KEY, detached); }, [detached]);
  useEffect(() => { lsSet(CHAT_FLOAT_KEY, floatRect); }, [floatRect]);

  const dockRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ y: number; h: number } | null>(null);        // docked vertical resize
  const dragRef = useRef<{ mx: number; my: number; x: number; y: number } | null>(null); // floating move
  const fResizeRef = useRef<{ mx: number; my: number; r: { x: number; y: number; w: number; h: number }; edge: string } | null>(null); // floating resize
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (resizeRef.current) {
        const r = resizeRef.current;
        setChatHeight(Math.max(CHAT_MIN_H, Math.min(chatMaxH(), r.h + (r.y - e.clientY))));
      } else if (dragRef.current) {
        const d = dragRef.current;
        setFloatRect((fr) => ({ ...fr, x: Math.max(0, d.x + (e.clientX - d.mx)), y: Math.max(0, d.y + (e.clientY - d.my)) }));
      } else if (fResizeRef.current) {
        const { mx, my, r, edge } = fResizeRef.current;
        const dx = e.clientX - mx, dy = e.clientY - my;
        let { x, y, w, h } = r;
        if (edge.includes("e")) w = r.w + dx;
        if (edge.includes("s")) h = r.h + dy;
        if (edge.includes("w")) { w = r.w - dx; x = r.x + dx; }
        if (edge.includes("n")) { h = r.h - dy; y = r.y + dy; }
        if (w < 300) { if (edge.includes("w")) x = r.x + (r.w - 300); w = 300; }
        if (h < CHAT_MIN_H) { if (edge.includes("n")) y = r.y + (r.h - CHAT_MIN_H); h = CHAT_MIN_H; }
        setFloatRect({ x, y, w, h });
      }
    };
    const up = () => { resizeRef.current = null; dragRef.current = null; fResizeRef.current = null; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, []);

  const startResize = (e: React.MouseEvent) => { e.preventDefault(); resizeRef.current = { y: e.clientY, h: chatHeight ?? (dockRef.current?.offsetHeight ?? defaultChatH()) }; };
  const startFloatDrag = (e: React.MouseEvent) => { dragRef.current = { mx: e.clientX, my: e.clientY, x: floatRect.x, y: floatRect.y }; };
  const startFloatResize = (edge: string) => (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); fResizeRef.current = { mx: e.clientX, my: e.clientY, r: floatRect, edge }; };
  const detach = () => setDetached(true);
  const snapBack = () => { setSnapping(true); window.setTimeout(() => { setSnapping(false); setDetached(false); }, 200); };
  const floating = detached && !narrow; // detach is a desktop-only affordance

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
              <Card style={{ borderLeft: `6px solid ${model.sessionAccent}`, padding: "12px 16px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: 3, whiteSpace: "nowrap" }}>{model.sessionTitle}</span>
                <span style={{ fontSize: 13, color: "#6B6B7B", letterSpacing: 1, flex: "1 1 200px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{model.sessionTask}</span>
                <Badge variant="secondary" style={{ color: model.sessionStateColor, letterSpacing: 2 }} className="text-[10px]">{model.sessionState}</Badge>
              </Card>

              {narrow && !floorOpen && (
                <ZoneStrip zones={L.zoneLabels} onExpand={() => setFloorOpen(true)} />
              )}
              <Card style={{ padding: 14, display: narrow && !floorOpen ? "none" : "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 10, letterSpacing: 2, color: "#6B6B7B", display: "inline-flex", alignItems: "center" }}>OFFICE FLOOR · CLICK AN AGENT{narrow ? <Button variant="outline" size="sm" onClick={() => setFloorOpen(false)} className="ml-2 h-6 px-2 text-[10px]">▴ HIDE</Button> : null}</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button variant="outline" size="icon" className="h-7 w-7" title="zoom out" onClick={() => setZoom((z) => Math.max(1, +(z - 0.25).toFixed(2)))}><Minus /></Button>
                    <Button variant={zoom === 1 ? "default" : "outline"} size="sm" className="h-7 px-3 text-[10px] tracking-widest" onClick={() => setZoom(1)}>FIT</Button>
                    <Button variant="outline" size="icon" className="h-7 w-7" title="zoom in" onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))}><Plus /></Button>
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
                          z.collapsed && z.zone
                            ? <g key={z.key} onClick={() => props.onDeskClick(z.zone!, 0)} style={{ cursor: "pointer" }}>
                                <rect x={z.x} y={z.y} width={z.w} height={z.h} fill={z.fill} fillOpacity={z.op} />
                                <rect x={z.x + z.w - 44} y={z.y + z.h / 2 - 3} width="20" height="6" fill="#6B6B7B" />
                                <rect x={z.x + z.w - 37} y={z.y + z.h / 2 - 10} width="6" height="20" fill="#6B6B7B" />
                              </g>
                            : <rect key={z.key} x={z.x} y={z.y} width={z.w} height={z.h} fill={z.fill} fillOpacity={z.op} />
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
                          <g key={d.key} onClick={() => props.onDeskClick(d.zone, d.slot)} style={{ cursor: "pointer" }}>
                            <use href="#deskEmpty" x={d.x} y={d.y} opacity="0.55" />
                            {/* a dim "+" marks the desk as placeable */}
                            <rect x={d.x + 44} y={d.y - 66} width="24" height="6" fill="#6B6B7B" opacity="0.7" />
                            <rect x={d.x + 53} y={d.y - 75} width="6" height="24" fill="#6B6B7B" opacity="0.7" />
                          </g>
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
                          <Button size="sm" onClick={props.onApprove} className="h-7 flex-1 px-2 text-[10px] tracking-wider" variant={sel.awaiting ? "default" : "secondary"} style={sel.awaiting ? { background: "#FBBF24", color: "#0D0D12" } : undefined}>APPROVE</Button>
                          <Button size="sm" variant="outline" onClick={props.onDeny} className="h-7 flex-1 px-2 text-[10px] tracking-wider">DENY</Button>
                          <Button size="sm" variant="outline" onClick={props.onDismiss} className="h-7 flex-1 px-2 text-[10px] tracking-wider" style={{ color: "#E879F9" }}>DISMISS</Button>
                        </div>
                        <div style={{ display: "flex", gap: 6 }}>
                          <Input type="text" value={props.steer} onChange={(e) => props.onSteerDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") props.onSteer(); }} placeholder="steer this agent…" className="h-8 flex-1 text-[10px] font-mono" />
                          <Button size="sm" onClick={props.onSteer} className="h-8 px-3 text-[10px] tracking-wider">STEER</Button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            </div>
          </div>

          {/* right column — roster + chat. Hidden while the chat is floating so
              the office floor expands to fill the freed width. */}
          {!floating && (
          <div style={{ flex: "1 1 320px", minWidth: "min(100%, 300px)", display: "flex", flexDirection: "column", gap: 12 }}>
            <Card style={{ display: "flex", flexDirection: "column", maxHeight: 320 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderBottom: "2px solid #2A2A38" }}>
                <span style={{ fontSize: 9, letterSpacing: 2, color: "#6B6B7B" }}>WHO IS WORKING</span>
                <span style={{ fontSize: 9, letterSpacing: 1, color: model.offFloorColor }}>{model.offFloorLine}</span>
              </div>
              <ScrollArea className="min-h-0" style={{ flex: "1 1 auto" }}>
                <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                  {L.roster.map((r) => (
                    <div key={r.key} onClick={() => props.onSelectFig(r.id)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 7px", cursor: "pointer", borderLeft: `3px solid ${r.accent}`, background: r.bg, opacity: r.opacity }}>
                      <span style={{ fontSize: 11, letterSpacing: 1, color: r.color, whiteSpace: "nowrap" }}>{r.name}</span>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 10, color: "#6B6B7B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.action}{r.manual ? " · manual" : ""}</span>
                      <Badge variant="secondary" className="px-1.5 py-0 text-[9px] tracking-wider" style={{ color: r.stateColor }}>{r.tag}</Badge>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </Card>

            {props.goalBar}

            <Card ref={dockRef} style={{ display: "flex", flexDirection: "column", position: "relative", ...(narrow ? { flex: "1 1 auto", minHeight: 340 } : { height: chatHeight ?? defaultChatH(), minHeight: CHAT_MIN_H, flex: "0 0 auto" }) }}>
              {!narrow && <div onMouseDown={startResize} title="drag to resize the chat" style={{ height: 8, flex: "0 0 auto", cursor: "ns-resize", background: "#101017", borderBottom: "1px solid #2A2A38" }} />}
              <ChatPanel {...props} detached={false} canDetach={!narrow} onToggleDetach={detach} />
            </Card>
          </div>
          )}
          {/* Background jobs: inline when there's room; a bottom sheet on narrow/mobile. */}
          {!narrow && props.rightPanel}
        </div>

        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 9, letterSpacing: 1, color: "#4A4A58", borderTop: "2px solid #2A2A38", paddingTop: 10 }}>
          <span>window.domOffice · add · update · think · remove · list · say · setFloor · addFloor · onUserMessage · onApproval</span>
          <span>capacity 1 · 2 · 8 · 2 · 6 — extras stay in WHO IS WORKING as OFF-FLOOR</span>
        </div>

        {mobile && <div style={{ height: 56 }} />}{/* spacer so the fixed bar doesn't cover content */}

        {/* Detached chat: a floating, draggable, resizable panel. Snap back with ⊟. */}
        {floating && (
          <Card style={{ position: "fixed", left: floatRect.x, top: floatRect.y, width: floatRect.w, height: floatRect.h, zIndex: 60, boxShadow: "0 24px 64px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column", ...(snapping ? { transition: "transform .2s ease, opacity .2s ease", transform: "scale(0.92)", opacity: 0, transformOrigin: "top right" } : {}) }}>
            <ChatPanel {...props} detached canDetach onToggleDetach={snapBack} onHeaderMouseDown={startFloatDrag} />
            {EDGES.map((edge) => (
              <div key={edge} onMouseDown={startFloatResize(edge)} style={{ position: "absolute", cursor: RESIZE_CURSOR[edge], zIndex: 2, ...RESIZE_POS[edge] }} />
            ))}
          </Card>
        )}
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

// Chips for the files staged for the next message, each with an ✕ to remove it.
function AttachBar(props: { attachments: { name: string; mime: string }[]; onRemove: (i: number) => void }) {
  if (props.attachments.length === 0) return null;
  const icon = (mime: string) => (mime.startsWith("image/") ? "🖼" : mime === "application/pdf" ? "📄" : "📎");
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {props.attachments.map((a, i) => (
        <div key={`${a.name}-${i}`} style={{ display: "flex", alignItems: "center", gap: 6, background: "#101017", border: "2px solid #2A2A38", padding: "3px 6px", fontFamily: MONO, fontSize: 10, color: "#C9C9D6", maxWidth: 220 }}>
          <span>{icon(a.mime)}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={a.name}>{a.name}</span>
          <button type="button" title="remove" onClick={() => props.onRemove(i)} style={{ fontFamily: MONO, fontSize: 11, lineHeight: 1, background: "transparent", color: "#F87171", border: 0, cursor: "pointer", padding: 0 }}>✕</button>
        </div>
      ))}
    </div>
  );
}

// Chat input with the SAME slash-command list the TUI shows (filtered as you type,
// arrows to select, Enter/Tab to complete) plus @-file autocomplete. A paperclip
// button (and drag-and-drop onto the row) stages real file uploads.
function ChatInput(props: { value: string; onChange: (v: string) => void; onSubmit: () => void; commands: CommandItem[]; requestFiles: (t: number, q: string) => Promise<string[]>; tabId: number | null; onAddFiles: (files: File[]) => void; canImage: boolean; canDoc: boolean }) {
  const { value } = props;
  const ref = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  // accept: text files always; images/PDFs only when the model can read them.
  const accept = [".txt,.md,.json,.csv,text/*", props.canImage ? "image/*" : "", props.canDoc ? "application/pdf" : ""].filter(Boolean).join(",");
  const pickFiles = (list: FileList | null) => { if (list && list.length) props.onAddFiles(Array.from(list)); };
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
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); pickFiles(e.dataTransfer.files); }}
        style={{ display: "flex", alignItems: "center", gap: 8, background: "#101017", border: `2px solid ${dragOver ? "#22D3EE" : "#2A2A38"}`, padding: "7px 9px" }}
      >
        <span style={{ color: "#22D3EE", fontSize: 12 }}>&gt;</span>
        <Input ref={ref} type="text" value={value} onChange={(e) => props.onChange(e.target.value)} onKeyDown={onKeyDown} placeholder="message this session… (/ commands, @ files, ⎘ to attach)"
          className="h-auto min-w-0 flex-1 border-0 bg-transparent px-0 py-0 text-[11px] font-mono shadow-none focus-visible:ring-0" />
        <input ref={fileRef} type="file" multiple accept={accept} onChange={(e) => { pickFiles(e.target.files); e.target.value = ""; }} style={{ display: "none" }} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" onClick={() => fileRef.current?.click()}><Paperclip /></Button>
          </TooltipTrigger>
          <TooltipContent>attach files</TooltipContent>
        </Tooltip>
        <span style={{ width: 7, height: 14, background: "#22D3EE", animation: "domCaret 1s steps(1) infinite" }} />
      </div>
    </div>
  );
}

// The chat rail's inner content (header · scrolling messages · pinned input). Used
// both docked (in the right column) and floating (detached). The messages area has
// a fixed height from its flex parent and scrolls internally, so a long task never
// grows the panel; auto-scroll follows new messages while the user is at the bottom,
// and a "↓ new message" pill appears when they've scrolled up to read history.
function ChatPanel(p: SessionsProps & { detached: boolean; canDetach: boolean; onToggleDetach: () => void; onHeaderMouseDown?: (e: React.MouseEvent) => void }) {
  const { model } = p;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const atBottomRef = useRef(true);
  const lastLen = useRef(p.chat.length);

  const onScroll = () => {
    const el = scrollRef.current; if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    atBottomRef.current = near;
    setAtBottom(near);
    if (near) setUnseen(false);
  };
  // Pin to bottom on first mount.
  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, []);
  // New messages: follow if at/near bottom, else surface the pill.
  useEffect(() => {
    if (p.chat.length > lastLen.current) {
      const el = scrollRef.current;
      if (atBottomRef.current && el) el.scrollTop = el.scrollHeight;
      else setUnseen(true);
    }
    lastLen.current = p.chat.length;
  }, [p.chat.length]);
  const jumpToBottom = () => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; atBottomRef.current = true; setAtBottom(true); setUnseen(false); };

  return (
    <>
      <div onMouseDown={p.onHeaderMouseDown} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderBottom: "2px solid #2A2A38", flex: "0 0 auto", cursor: p.onHeaderMouseDown ? "move" : "default", userSelect: "none" }}>
        <span style={{ fontSize: 9, letterSpacing: 2, color: "#6B6B7B" }}>{model.chatHeader}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Badge variant="secondary" className="px-1.5 py-0 text-[9px] tracking-wider" style={{ color: "#22D3EE" }}>LIVE</Badge>
          {p.canDetach && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" onMouseDown={(e) => e.stopPropagation()} onClick={p.onToggleDetach}>
                  {p.detached ? <Minimize2 /> : <Maximize2 />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{p.detached ? "dock (snap back)" : "detach into a floating panel"}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      <div style={{ position: "relative", flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
        <ScrollArea viewportRef={scrollRef} onViewportScroll={onScroll} className="min-h-0" style={{ flex: "1 1 auto" }}>
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
          {p.chat.map((m) => {
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
                    <Button size="sm" onClick={() => p.onApproveMsg(m.permId)} className="h-7 px-3 text-[10px] tracking-wider" style={{ background: "#FBBF24", color: "#0D0D12" }}>APPROVE</Button>
                    <Button variant="outline" size="sm" onClick={() => p.onDenyMsg(m.permId)} className="h-7 px-3 text-[10px] tracking-wider">DENY</Button>
                  </div>
                )}
                {p.canSaveVault && p.onSaveMsg && m.kind === "assistant" && (
                  <div style={{ display: "flex" }}>
                    <Button variant="ghost" size="sm" title="save this message as an Obsidian note" onClick={() => p.onSaveMsg!(messageToText(m))} className="h-6 gap-1 px-2 text-[9px] tracking-wider" style={{ color: "#A78BFA" }}>
                      <ArrowDown className="h-3 w-3" /> SAVE TO VAULT
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
          </div>
        </ScrollArea>
        {unseen && !atBottom && (
          <Button size="sm" onClick={jumpToBottom} className="absolute left-1/2 h-7 -translate-x-1/2 gap-1 rounded-full px-3 text-[10px]" style={{ bottom: 10, boxShadow: "0 6px 16px rgba(0,0,0,0.5)" }}>
            <ArrowDown className="h-3 w-3" /> new message
          </Button>
        )}
      </div>
      <div style={{ borderTop: "2px solid #2A2A38", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, flex: "0 0 auto" }}>
        <AttachBar attachments={p.attachments} onRemove={p.onRemoveAttachment} />
        <ChatInput value={p.draft} onChange={p.onDraft} onSubmit={p.onSend} commands={p.commands} requestFiles={p.requestFiles} tabId={p.activeTabId} onAddFiles={p.onAddFiles} canImage={p.canImage} canDoc={p.canDoc} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontSize: 9, letterSpacing: 1, color: "#6B6B7B" }}>{model.ctxLine}</span>
          <Button size="sm" onClick={p.onSend} className="h-8 px-4 text-[10px] tracking-widest">SEND</Button>
        </div>
      </div>
    </>
  );
}

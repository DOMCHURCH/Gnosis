import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SessionsModel, ZoneId } from "./sessions";
import { ZONE_BY_ID } from "./sessions.js";
import type { CommandItem } from "./store";
import type { ChatSegment, ToolPayload } from "./chatgroups";
import { DiffView, FileView } from "./DiffView";
import { elapsedLabel } from "./telemetry.js";
import { TaskPlanView } from "./TaskPlanView";
import type { TaskPlan } from "./taskplan";
import { ThreeFloor } from "./ThreeFloor";
import { FloorMinimap } from "./FloorMinimap";
import { AskCard } from "./AskCard";
import { FileOutputView } from "./FileOutput";
import type { FileOutput } from "./filekind";
import { messageStyle } from "./chatgroups.js";
import { centerScrollLeft } from "./sessions.js";

export interface ChatMsg { key: string; from: string; color: string; time: string; kind: string; segments: ChatSegment[]; border: string; isApproval: boolean; permId?: string; resolved?: string; tool?: ToolPayload; fileOutput?: FileOutput | null; autoSaved?: string; askId?: string; options?: string[]; answered?: string; verdict?: "pass" | "fail" | "unknown"; confidence?: number; }
export interface SelDetail {
  id: string; name: string; zone: string; color: string; stateColor: string; state: string;
  action: string; output: string[]; thinking: string[]; awaiting: boolean;
  /** Telemetry for the agent's tab (tokens, tool counts, success rate, sparkline). */
  tele: {
    tokens: number; cachedTokens: number; turns: number;
    tools: { name: string; count: number; ok: number; fail: number }[];
    total: number; successRate: number | null; spark: string; turnStart: number | null;
  };
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
  /** ask_user: reply to the agent's question from the chat rail. */
  onAnswerAsk?: (askId: string | undefined, text: string) => void;
  /** Feed a failed outcome's critique back as the next turn. */
  onFixOutcome?: () => void;
  /** Re-run one of your own messages as a background agent in a new tab. */
  onRunBackground?: (text: string) => void;
  /** Token-gated URL builder for rich file output (raw bytes vs text preview). */
  fileUrl?: (path: string, raw: boolean) => string;
  /** Save a written file into the Obsidian vault (images only, today). */
  onSaveFile?: (path: string) => void;
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
  /** The active coordinated-task plan for the active tab (null when none). Rendered
   * both above the chat rail and floating over the coordinator desk on the floor. */
  plan?: TaskPlan | null;
  /** The goal bar, rendered directly above the chat rail. */
  goalBar?: ReactNode;
  /** Live streaming-edit diff viewer for the active tab (null when none). */
  streamPanel?: ReactNode;
  /** Design-mode before/after screenshots for the active tab (null when none). */
  designPanel?: ReactNode;
  /** Optional collapsible panel rendered at the far left (the File Browser). */
  leftPanel?: ReactNode;
  /** Optional collapsible panel rendered at the far right (the Background jobs panel). */
  rightPanel?: ReactNode;
  /** The WEBHOOKS panel body — its own bottom-nav tab on mobile. */
  webhooksPanel?: ReactNode;
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
  const mobile = vw > 0 && vw < 640; // phones: dedicated one-handed layout (bottom nav)
  const narrow = vw > 0 && vw < 900; // tablets: floor collapses to a zone strip
  const [mobileTab, setMobileTab] = useState<"chat" | "floor" | "files" | "webhooks">("chat");
  const [floorOpen, setFloorOpen] = useState(false); // narrow: expand the full floor
  const [filesOpen, setFilesOpen] = useState(false);  // narrow/mobile: file browser bottom sheet
  const [jobsOpen, setJobsOpen] = useState(false);    // narrow/mobile: background jobs bottom sheet

  // The horizontally-scrolling wrapper around the floor SVG. The minimap reads its
  // live scroll geometry (and writes it on click), so it needs the node itself; the
  // epoch just forces a re-render whenever that geometry changes.
  const floorScrollRef = useRef<HTMLDivElement>(null);
  const mobileScrollRef = useRef<HTMLDivElement>(null);
  const [floorEpoch, setFloorEpoch] = useState(0);
  const bumpFloor = () => setFloorEpoch((n) => n + 1);
  useEffect(() => { bumpFloor(); }, [zoom]);
  // "N AWAITING" in the floor header: scroll the first blocked agent into view and
  // select it, so one click gets from "something is stuck" to the prompt itself.
  const gotoAwaiting = () => {
    if (model.firstAwaitingId) props.onSelectFig(model.firstAwaitingId);
    const node = floorScrollRef.current;
    if (!node || model.firstAwaitingX == null) return;
    node.scrollTo({ left: centerScrollLeft(model.firstAwaitingX, node.clientWidth, node.scrollWidth), behavior: "smooth" });
  };

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

  // --- MOBILE (< 640px): a one-handed layout — bottom nav over full-screen tabs,
  // bottom sheets for agent detail and permission prompts. Everything above already
  // ran its hooks, so this early return is safe.
  if (mobile) {
    const pendingPerm = props.chat.find((m) => m.isApproval && !m.resolved);
    const nav: [typeof mobileTab, string, string][] = [["chat", "▤", "CHAT"], ["floor", "◫", "FLOOR"], ["files", "≡", "FILES"], ["webhooks", "⚑", "WEBHOOKS"]];
    return (
      <div style={{ minHeight: "100vh", background: "#0D0D12", color: "#C9C9D6", fontFamily: MONO, display: "flex", flexDirection: "column" }}>
        <style>{"@keyframes domSheet{from{transform:translateY(100%)}to{transform:translateY(0)}} .dom-sheet{animation:domSheet .2s ease-out}"}</style>
        <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column", paddingBottom: 56 }}>
          {mobileTab === "chat" && (
            <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <ChatPanel {...props} detached={false} canDetach={false} onToggleDetach={() => {}} mobile />
            </div>
          )}
          {mobileTab === "floor" && (
            <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ background: "#15151C", border: "2px solid #2A2A38", borderLeft: `6px solid ${model.sessionAccent}`, padding: "10px 12px", display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{model.sessionTitle}</span>
                <span style={{ marginLeft: "auto", fontSize: 9, letterSpacing: 2, color: model.sessionStateColor, whiteSpace: "nowrap" }}>{model.sessionState}</span>
              </div>
              <div style={{ position: "relative", background: "#15151C", border: "2px solid #2A2A38", padding: 8 }}>
                {/* Context-usage bar across the very top of the floor container. */}
                {model.tokenBar.known && (
                  <div title={`${model.tokenBar.label} of the session context limit`} style={{ position: "absolute", left: 0, right: 0, top: 0, height: 2, background: "#101017" }}>
                    <div style={{ width: `${model.tokenBar.pct}%`, height: "100%", background: model.tokenBar.color }} />
                  </div>
                )}
                <div ref={mobileScrollRef} onScroll={bumpFloor} style={{ overflowX: "auto", overflowY: "hidden" }}>
                  <ThreeFloor L={L} plan={props.plan} onSelectFig={props.onSelectFig} onDeskClick={props.onDeskClick} />
                </div>
                <FloorMinimap L={L} scrollRef={mobileScrollRef} epoch={floorEpoch} mobile />
              </div>
            </div>
          )}
          {mobileTab === "files" && <div style={{ flex: 1, minHeight: 0, display: "flex", padding: 8 }}>{props.leftPanel}</div>}
          {mobileTab === "webhooks" && <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 12 }}>{props.webhooksPanel}</div>}
        </div>

        {/* bottom navigation */}
        <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, height: 56, zIndex: 40, display: "flex", background: "#15151C", borderTop: "2px solid #2A2A38" }}>
          {nav.map(([id, icon, label]) => {
            const active = mobileTab === id;
            return (
              <button key={id} type="button" onClick={() => setMobileTab(id)} style={{ flex: 1, minHeight: 44, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, background: "transparent", border: 0, cursor: "pointer", color: active ? "#22D3EE" : "#6B6B7B", fontFamily: MONO }}>
                <span style={{ fontSize: 16 }}>{icon}</span>
                <span style={{ fontSize: 8, letterSpacing: 1 }}>{label}</span>
              </button>
            );
          })}
        </div>

        {/* agent detail bottom sheet (tap an agent on the FLOOR tab) */}
        {sel && (
          <div onClick={props.onClose} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(5,5,8,0.6)", display: "flex", alignItems: "flex-end" }}>
            <div className="dom-sheet" onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxHeight: "72vh", overflow: "auto", background: "#0D0D12", borderTop: "2px solid #2A2A38", display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", justifyContent: "center", padding: "6px 0" }}><div style={{ width: 40, height: 4, background: "#2A2A38" }} /></div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 14px 10px" }}>
                <span style={{ width: 9, height: 9, background: sel.stateColor }} />
                <span style={{ fontSize: 14, letterSpacing: 1, color: sel.color }}>{sel.name}</span>
                <span style={{ fontSize: 10, letterSpacing: 1, color: sel.stateColor }}>{sel.state.toUpperCase()}</span>
                <button type="button" onClick={props.onClose} style={{ marginLeft: "auto", fontSize: 16, minWidth: 44, minHeight: 44, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer" }}>✕</button>
              </div>
              <div style={{ padding: "0 14px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ fontSize: 9, letterSpacing: 2, color: "#6B6B7B" }}>CURRENT TASK</div>
                <div style={{ fontSize: 12, lineHeight: 1.6, color: "#C9C9D6", background: "#15151C", border: "2px solid #2A2A38", padding: 10 }}>{sel.action}</div>
                <div style={{ fontSize: 9, letterSpacing: 2, color: "#6B6B7B" }}>RECENT OUTPUT</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, background: "#0B0B10", border: "2px solid #2A2A38", padding: 10 }}>
                  {(sel.output.length ? sel.output : ["no output yet"]).map((o, i) => (<div key={i} style={{ fontSize: 11, lineHeight: 1.5, color: "#6B6B7B", whiteSpace: "pre-wrap" }}>{o}</div>))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* permission prompt as a bottom sheet (not a modal) */}
        {pendingPerm && (
          <div style={{ position: "fixed", inset: 0, zIndex: 55, background: "rgba(5,5,8,0.7)", display: "flex", alignItems: "flex-end" }}>
            <div className="dom-sheet" style={{ width: "100%", background: "#0D0D12", borderTop: "2px solid #FBBF24", display: "flex", flexDirection: "column", padding: 14, gap: 12 }}>
              <div style={{ fontSize: 10, letterSpacing: 2, color: "#FBBF24" }}>APPROVAL NEEDED</div>
              <div style={{ fontSize: 12, lineHeight: 1.5, color: "#C9C9D6", background: "#15151C", border: "2px solid #2A2A38", padding: 10, maxHeight: "40vh", overflow: "auto", whiteSpace: "pre-wrap" }}>
                {pendingPerm.segments.map((s) => s.text).join("\n")}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button type="button" onClick={() => props.onApproveMsg(pendingPerm.permId)} style={{ flex: 1, minHeight: 44, fontFamily: MONO, fontSize: 12, letterSpacing: 1, background: "#FBBF24", color: "#0D0D12", border: 0, cursor: "pointer" }}>APPROVE</button>
                <button type="button" onClick={() => props.onDenyMsg(pendingPerm.permId)} style={{ flex: 1, minHeight: 44, fontFamily: MONO, fontSize: 12, letterSpacing: 1, background: "#15151C", color: "#C9C9D6", border: "2px solid #2A2A38", cursor: "pointer" }}>DENY</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#0D0D12", color: "#C9C9D6", fontFamily: MONO, padding: 24, boxSizing: "border-box", display: "flex", justifyContent: "center" }}>
      <div style={{ width: "100%", maxWidth: 1560, display: "flex", flexDirection: "column", gap: 16 }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24, borderBottom: "2px solid #2A2A38", paddingBottom: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
            <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: 4 }}>Gnosis</span>
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
                <button key={f.key} type="button" onClick={() => props.onSelectFloor(f.id)} title={f.name} style={{ fontFamily: "inherit", width: 64, height: 62, background: f.bg, color: f.fg, border: `2px solid ${f.border}`, borderLeft: `5px solid ${f.accent}`, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, padding: "0 3px", overflow: "hidden" }}>
                  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.5, lineHeight: 1.15, textAlign: "center", wordBreak: "break-word", overflow: "hidden", maxHeight: 34 }}>{f.label || f.num}</span>
                  <span style={{ width: 8, height: 8, background: f.dot, ...(f.dotAnim || {}) }} />
                </button>
              ))}
              <button type="button" onClick={props.onAddFloor} style={{ fontFamily: "inherit", width: 64, height: 40, background: "#101017", color: "#6B6B7B", border: "2px dashed #2A2A38", cursor: "pointer", fontSize: 15 }}>+</button>
              <div style={{ fontSize: 8, letterSpacing: 1, color: "#4A4A58", textAlign: "center", lineHeight: 1.5, paddingTop: 4 }}>CLI<br />WINDOWS</div>
            </div>

            {/* center column */}
            <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ background: "#15151C", border: "2px solid #2A2A38", borderLeft: `6px solid ${model.sessionAccent}`, padding: "12px 16px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                {model.sessionNum && <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1, color: "#4A4A58", whiteSpace: "nowrap" }}>{model.sessionNum}</span>}
                <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "60%" }}>{model.sessionTitle}</span>
                <span style={{ fontSize: 13, color: "#6B6B7B", letterSpacing: 1, flex: "1 1 200px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{model.sessionTask}</span>
                <span style={{ fontSize: 10, letterSpacing: 2, color: model.sessionStateColor, whiteSpace: "nowrap" }}>{model.sessionState}</span>
              </div>

              {narrow && !floorOpen && (
                <ZoneStrip zones={L.zoneLabels} onExpand={() => setFloorOpen(true)} />
              )}
              <div style={{ background: "#15151C", border: "2px solid #2A2A38", padding: 14, display: narrow && !floorOpen ? "none" : "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10, letterSpacing: 2, color: "#6B6B7B" }}>
                    {/* Live system state at a glance: green = idle, cyan = working,
                        amber = blocked on an approval. Replaces the static LIVE tag. */}
                    <span title={model.sessionState} style={{ width: 8, height: 8, background: model.floorDot, ...(model.floorDotPulse ? { animation: "domTab 1.4s ease-in-out infinite" } : {}) }} />
                    <span>OFFICE FLOOR · CLICK AN AGENT</span>
                    {model.floorAwaitingCount > 0
                      ? <button type="button" onClick={gotoAwaiting} title="scroll to the first agent waiting on you"
                          style={{ fontFamily: "inherit", fontSize: 10, letterSpacing: 2, background: "transparent", color: model.floorCountColor, border: 0, padding: 0, cursor: "pointer" }}>{model.floorCount}</button>
                      : <span style={{ color: model.floorCountColor }}>{model.floorCount}</span>}
                    {model.tokenBar.known && <span style={{ color: model.tokenBar.color }}>{model.tokenBar.label}</span>}
                    {narrow ? <button type="button" onClick={() => setFloorOpen(false)} style={{ ...ZBTN, padding: "2px 8px" }}>▴ HIDE</button> : null}
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" onClick={() => { setZoom((z) => Math.max(1, +(z - 0.25).toFixed(2))); }} style={ZBTN}>−</button>
                    <button type="button" onClick={() => { setZoom(1); }} style={{ ...ZBTN, color: zoom === 1 ? "#22D3EE" : "#C9C9D6", borderColor: zoom === 1 ? "#22D3EE" : "#2A2A38" }}>FIT</button>
                    <button type="button" onClick={() => { setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2))); }} style={ZBTN}>+</button>
                  </div>
                </div>

                <div style={{ position: "relative" }}>
                  {/* A 2px context meter across the very top of the floor: cumulative
                      session tokens against the model's context limit. */}
                  {model.tokenBar.known && (
                    <div title={`${model.tokenBar.label} of the session context limit`} style={{ position: "absolute", left: 0, right: 0, top: 0, height: 2, zIndex: 2, background: "#101017" }}>
                      <div style={{ width: `${model.tokenBar.pct}%`, height: "100%", background: model.tokenBar.color }} />
                    </div>
                  )}
                  <div ref={floorScrollRef} onScroll={bumpFloor} style={{ overflowX: zoom > 1 ? "auto" : "hidden", overflowY: "hidden" }}>
                    <div style={{ position: "relative", width: `${zoom * 100}%` }}>
                      <ThreeFloor L={L} plan={props.plan} onSelectFig={props.onSelectFig} onDeskClick={props.onDeskClick} />
                    </div>
                  </div>
                  <FloorMinimap L={L} scrollRef={floorScrollRef} epoch={floorEpoch} />

                  {sel && (
                    <AgentTelemetryPanel
                      sel={sel}
                      steer={props.steer}
                      onClose={props.onClose}
                      onApprove={props.onApprove}
                      onDeny={props.onDeny}
                      onDismiss={props.onDismiss}
                      onSteer={props.onSteer}
                      onSteerDraft={props.onSteerDraft}
                    />
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* right column — roster + chat. Hidden while the chat is floating so
              the office floor expands to fill the freed width. */}
          {!floating && (
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
                    <span style={{ flex: 1, minWidth: 0, fontSize: 10, color: "#6B6B7B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.action}{r.manual ? " · manual" : ""}</span>
                    <span style={{ fontSize: 9, letterSpacing: 1, color: r.stateColor, whiteSpace: "nowrap" }}>{r.tag}</span>
                  </div>
                ))}
              </div>
            </div>

            {props.goalBar}

            {props.plan && <TaskPlanView plan={props.plan} />}

            {props.designPanel}

            {props.streamPanel}

            <div ref={dockRef} style={{ background: "#15151C", border: "2px solid #2A2A38", display: "flex", flexDirection: "column", position: "relative", ...(narrow ? { flex: "1 1 auto", minHeight: 340 } : { height: chatHeight ?? defaultChatH(), minHeight: CHAT_MIN_H, flex: "0 0 auto" }) }}>
              {!narrow && <div onMouseDown={startResize} title="drag to resize the chat" style={{ height: 8, flex: "0 0 auto", cursor: "ns-resize", background: "#101017", borderBottom: "1px solid #2A2A38" }} />}
              <ChatPanel {...props} detached={false} canDetach={!narrow} onToggleDetach={detach} />
            </div>
          </div>
          )}
          {/* Background jobs: inline when there's room; a bottom sheet on narrow/mobile. */}
          {!narrow && props.rightPanel}
        </div>

        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 9, letterSpacing: 1, color: "#4A4A58", borderTop: "2px solid #2A2A38", paddingTop: 10 }}>
          <span>window.gnosisOffice · add · update · think · remove · list · say · setFloor · addFloor · onUserMessage · onApproval</span>
          <span>capacity 1 · 2 · 8 · 2 · 6 — extras stay in WHO IS WORKING as OFF-FLOOR</span>
        </div>

        {mobile && <div style={{ height: 56 }} />}{/* spacer so the fixed bar doesn't cover content */}

        {/* Detached chat: a floating, draggable, resizable panel. Snap back with ⊟. */}
        {floating && (
          <div style={{ position: "fixed", left: floatRect.x, top: floatRect.y, width: floatRect.w, height: floatRect.h, zIndex: 60, background: "#15151C", border: "2px solid #2A2A38", boxShadow: "0 24px 64px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column", ...(snapping ? { transition: "transform .2s ease, opacity .2s ease", transform: "scale(0.92)", opacity: 0, transformOrigin: "top right" } : {}) }}>
            <ChatPanel {...props} detached canDetach onToggleDetach={snapBack} onHeaderMouseDown={startFloatDrag} />
            {EDGES.map((edge) => (
              <div key={edge} onMouseDown={startFloatResize(edge)} style={{ position: "absolute", cursor: RESIZE_CURSOR[edge], zIndex: 2, ...RESIZE_POS[edge] }} />
            ))}
          </div>
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
            <button key={f.key} type="button" onClick={() => props.onSelectFloor(f.id)} title={f.name} style={{ fontFamily: MONO, flex: "0 0 auto", minWidth: 44, maxWidth: 96, height: 40, background: f.bg, color: f.fg, border: `2px solid ${f.border}`, borderBottom: `4px solid ${f.accent}`, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, padding: "0 8px" }}>
              <span style={{ fontSize: 10, fontWeight: 700, maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.label || f.num}</span>
              <span style={{ width: 7, height: 7, background: f.dot, ...(f.dotAnim || {}) }} />
            </button>
          ))}
          <button type="button" onClick={props.onAddFloor} style={{ fontFamily: MONO, flex: "0 0 auto", width: 40, height: 40, background: "#101017", color: "#6B6B7B", border: "2px dashed #2A2A38", cursor: "pointer", fontSize: 15 }}>+</button>
        </div>
      )}
    </div>
  );
}

// The agent telemetry panel: replaces the old simple popup. Shows the selected
// agent's current task + status, live elapsed time, tokens (total + cached), tool
// calls by name with a success rate, and a per-turn token sparkline — all folded
// from the event stream. Keeps the approve/deny/dismiss/steer controls.
function Stat(props: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, background: "#0B0B10", border: "1px solid #2A2A38", padding: "5px 7px", minWidth: 0 }}>
      <span style={{ fontSize: 8, letterSpacing: 1, color: "#4A4A58" }}>{props.label}</span>
      <span style={{ fontSize: 12, color: props.color ?? "#C9C9D6", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{props.value}</span>
    </div>
  );
}
function AgentTelemetryPanel(props: {
  sel: SelDetail; steer: string;
  onClose: () => void; onApprove: () => void; onDeny: () => void; onDismiss: () => void; onSteer: () => void; onSteerDraft: (v: string) => void;
}) {
  const { sel } = props;
  const t = sel.tele;
  // Live 1s tick while the agent is mid-turn so elapsed counts up.
  const [, setNow] = useState(0);
  useEffect(() => {
    if (t.turnStart == null) return;
    const iv = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, [t.turnStart]);
  const elapsed = t.turnStart != null ? elapsedLabel(t.turnStart, Date.now()) : "idle";
  const rate = t.successRate == null ? "—" : `${Math.round(t.successRate * 100)}%`;
  const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

  return (
    <div style={{ position: "absolute", right: 12, bottom: 12, width: "min(340px, 94%)", maxHeight: "94%", overflowY: "auto", background: "#101017", border: "2px solid #2A2A38", boxShadow: "0 14px 34px rgba(0,0,0,0.7)", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 11px", borderBottom: "2px solid #2A2A38" }}>
        <span style={{ width: 8, height: 8, background: sel.stateColor }} />
        <span style={{ fontSize: 12, letterSpacing: 2, color: sel.color }}>{sel.name}</span>
        <span style={{ fontSize: 9, letterSpacing: 1, color: sel.stateColor }}>{sel.state.toUpperCase()}</span>
        <span style={{ fontSize: 9, letterSpacing: 1, color: "#6B6B7B", marginLeft: "auto" }}>{sel.zone}</span>
        <button type="button" onClick={props.onClose} style={{ fontFamily: "inherit", fontSize: 11, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer" }}>✕</button>
      </div>
      <div style={{ padding: 11, display: "flex", flexDirection: "column", gap: 9 }}>
        <div style={{ fontSize: 9, letterSpacing: 2, color: "#6B6B7B" }}>CURRENT TASK</div>
        <div style={{ fontSize: 11, lineHeight: 1.6, color: "#C9C9D6", background: "#15151C", border: "2px solid #2A2A38", padding: 8, textWrap: "pretty" }}>{sel.action}</div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5 }}>
          <Stat label="ELAPSED" value={elapsed} color={t.turnStart != null ? "#22D3EE" : "#6B6B7B"} />
          <Stat label="TURNS" value={String(t.turns)} />
          <Stat label="SUCCESS" value={rate} color={t.successRate != null && t.successRate < 0.8 ? "#FBBF24" : "#4ADE80"} />
          <Stat label="TOKENS" value={fmtK(t.tokens)} />
          <Stat label="CACHED" value={fmtK(t.cachedTokens)} color="#818CF8" />
          <Stat label="TOOLS" value={String(t.total)} />
        </div>

        <div style={{ fontSize: 9, letterSpacing: 2, color: "#6B6B7B" }}>ACTIVITY · TOKENS/TURN</div>
        <div style={{ fontSize: 15, lineHeight: 1, letterSpacing: 1, color: "#22D3EE", background: "#0B0B10", border: "1px solid #2A2A38", padding: "6px 8px", overflow: "hidden", whiteSpace: "nowrap" }}>
          {t.spark || <span style={{ fontSize: 10, color: "#4A4A58" }}>no turns yet</span>}
        </div>

        <div style={{ fontSize: 9, letterSpacing: 2, color: "#6B6B7B" }}>TOOL CALLS</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 3, background: "#0B0B10", border: "2px solid #2A2A38", padding: 8, maxHeight: 120, overflowY: "auto" }}>
          {t.tools.length ? t.tools.map((tc) => (
            <div key={tc.name} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10 }}>
              <span style={{ flex: 1, minWidth: 0, color: "#C9C9D6", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tc.name}</span>
              {tc.fail > 0 && <span style={{ color: "#F87171" }}>{tc.fail}✗</span>}
              <span style={{ color: "#6B6B7B" }}>×{tc.count}</span>
            </div>
          )) : <div style={{ fontSize: 10, color: "#6B6B7B" }}>no tool calls yet</div>}
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
  // Tool calls read as machinery, not conversation: inset behind a left rule, on
  // their own tint, a notch smaller than the prose around them.
  const st = messageStyle("tool", false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, background: st.bg, borderLeft: st.borderLeft, padding: "5px 8px", fontSize: `${st.fontSize}em` }}>
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
function ChatInput(props: { value: string; onChange: (v: string) => void; onSubmit: () => void; commands: CommandItem[]; requestFiles: (t: number, q: string) => Promise<string[]>; tabId: number | null; onAddFiles: (files: File[]) => void; canImage: boolean; canDoc: boolean; mobile?: boolean }) {
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
        style={{ display: "flex", alignItems: "center", gap: 8, background: "#101017", border: `2px solid ${dragOver ? "#22D3EE" : "#2A2A38"}`, padding: props.mobile ? "5px 7px" : "7px 9px", minHeight: props.mobile ? 44 : undefined, boxSizing: "border-box" }}
      >
        <input ref={fileRef} type="file" multiple accept={accept} onChange={(e) => { pickFiles(e.target.files); e.target.value = ""; }} style={{ display: "none" }} />
        {/* On mobile: paperclip left, larger input, SEND right (one-handed). */}
        {props.mobile
          ? <button type="button" title="attach files" onClick={() => fileRef.current?.click()} style={{ fontFamily: MONO, fontSize: 18, lineHeight: 1, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer", minWidth: 40, minHeight: 40 }}>📎</button>
          : <span style={{ color: "#22D3EE", fontSize: 12 }}>&gt;</span>}
        <input ref={ref} type="text" value={value} onChange={(e) => props.onChange(e.target.value)} onKeyDown={onKeyDown} placeholder={props.mobile ? "message…" : "message this session… (/ commands, @ files, ⎘ to attach)"} style={{ flex: 1, minWidth: 0, fontSize: props.mobile ? 15 : 11, color: "#C9C9D6", background: "transparent", border: 0, outline: "none", fontFamily: MONO }} />
        {props.mobile
          ? <button type="button" onClick={props.onSubmit} style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 1, background: "#22D3EE", color: "#0D0D12", border: 0, minWidth: 56, minHeight: 40, cursor: "pointer" }}>SEND</button>
          : (<>
              <button type="button" title="attach files" onClick={() => fileRef.current?.click()} style={{ fontFamily: MONO, fontSize: 14, lineHeight: 1, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer", padding: "0 2px" }}>📎</button>
              <span style={{ width: 7, height: 14, background: "#22D3EE", animation: "domCaret 1s steps(1) infinite" }} />
            </>)}
      </div>
    </div>
  );
}

// The chat rail's inner content (header · scrolling messages · pinned input). Used
// both docked (in the right column) and floating (detached). The messages area has
// a fixed height from its flex parent and scrolls internally, so a long task never
// grows the panel; auto-scroll follows new messages while the user is at the bottom,
// and a "↓ new message" pill appears when they've scrolled up to read history.
function ChatPanel(p: SessionsProps & { detached: boolean; canDetach: boolean; onToggleDetach: () => void; onHeaderMouseDown?: (e: React.MouseEvent) => void; mobile?: boolean }) {
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
          {p.canDetach && (
            <button type="button" title={p.detached ? "dock (snap back)" : "detach into a floating panel"} onMouseDown={(e) => e.stopPropagation()} onClick={p.onToggleDetach}
              style={{ fontFamily: MONO, fontSize: 13, lineHeight: 1, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer", padding: 0 }}>
              {p.detached ? "⊟" : "⊞"}
            </button>
          )}
        </div>
      </div>
      <div style={{ position: "relative", flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div ref={scrollRef} onScroll={onScroll} style={{ flex: "1 1 auto", overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
          {p.chat.map((m) => {
            if (m.kind === "tool" && m.tool) {
              return (
                <div key={m.key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <ToolLine tool={m.tool} />
                  {m.fileOutput && p.fileUrl && (
                    <div style={{ paddingLeft: 10 }}>
                      <FileOutputView out={m.fileOutput} fileUrl={p.fileUrl} onSaveVault={p.onSaveFile} />
                    </div>
                  )}
                </div>
              );
            }
            const resolvedColor = m.resolved ? (m.resolved === "no" ? "#F87171" : "#4ADE80") : null;
            // One visual treatment per message type so a long scroll is scannable
            // without reading a word — see messageStyle in chatgroups.js.
            const st = messageStyle(m.kind, m.isApproval);
            return (
              <div key={m.key} style={{ display: "flex", flexDirection: "column", gap: 5, ...(st.wrapTint ? { background: st.wrapTint, padding: 8 } : {}), ...(st.centered ? { alignItems: "center", textAlign: "center" } : {}) }}>
                {st.showMeta && (
                  <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 9, letterSpacing: 1 }}>
                    <span style={{ width: 8, height: 8, background: m.color }} />
                    <span style={{ color: m.color }}>{m.from}</span>
                    <span style={{ color: "#6B6B7B" }}>{m.time}</span>
                  </div>
                )}
                <div style={{
                  fontSize: `${11 * st.fontSize}px`, lineHeight: 1.6,
                  color: resolvedColor ?? (st.color || "#C9C9D6"),
                  background: st.bg,
                  ...(st.boxed ? { border: `2px solid ${m.border}`, padding: 8 } : {}),
                  ...(st.borderLeft ? { borderLeft: st.borderLeft, paddingLeft: 8 } : {}),
                  ...(st.borderRight ? { borderRight: st.borderRight, paddingRight: 8 } : {}),
                  display: "flex", flexDirection: "column", gap: 6,
                }}>
                  {m.segments.map((s, i) => s.type === "code"
                    ? <CodeBlock key={i} lang={s.lang} text={s.text} />
                    : <div key={i} style={{ textWrap: "pretty", whiteSpace: "pre-wrap", color: resolvedColor ?? undefined }}>{s.text}</div>)}
                </div>
                {m.kind === "user" && p.onRunBackground && (
                  <div className="msg-actions" style={{ display: "flex", justifyContent: "flex-end" }}>
                    <button type="button" title="run this message again as a background agent"
                      onClick={() => p.onRunBackground!(messageToText(m))}
                      style={{ fontFamily: "inherit", fontSize: 9, letterSpacing: 1, background: "transparent", color: "#818CF8", border: "1px solid #2A2A38", padding: "3px 8px", cursor: "pointer" }}>
                      ⇥ RUN IN BACKGROUND
                    </button>
                  </div>
                )}
                {m.kind === "outcome" && m.verdict === "fail" && p.onFixOutcome && (
                  <div style={{ display: "flex", justifyContent: "center" }}>
                    <button type="button" onClick={() => p.onFixOutcome!()}
                      style={{ fontFamily: "inherit", fontSize: 9, letterSpacing: 1, background: "transparent", color: "#FBBF24", border: "1px solid #FBBF24", padding: "3px 10px", cursor: "pointer" }}>
                      FIX IT
                    </button>
                  </div>
                )}
                {m.kind === "ask" && (
                  m.answered
                    ? <div style={{ fontSize: 10, letterSpacing: 1, color: "#4ADE80" }}>↳ {m.answered}</div>
                    : <AskCard options={m.options ?? []} onAnswer={(t) => p.onAnswerAsk?.(m.askId, t)} />
                )}
                {m.isApproval && (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button type="button" onClick={() => p.onApproveMsg(m.permId)} style={{ fontFamily: "inherit", fontSize: 10, letterSpacing: 1, background: "#FBBF24", color: "#0D0D12", border: 0, padding: "6px 12px", cursor: "pointer" }}>APPROVE</button>
                    <button type="button" onClick={() => p.onDenyMsg(m.permId)} style={{ fontFamily: "inherit", fontSize: 10, letterSpacing: 1, background: "#101017", color: "#C9C9D6", border: "2px solid #2A2A38", padding: "4px 12px", cursor: "pointer" }}>DENY</button>
                  </div>
                )}
                {p.canSaveVault && m.kind === "assistant" && (
                  m.autoSaved
                    ? <div style={{ fontSize: 9, letterSpacing: 1, color: "#6B6B7B", fontStyle: "italic" }}>⬇ auto-saved to vault · {m.autoSaved}</div>
                    : p.onSaveMsg && (
                      <div style={{ display: "flex" }}>
                        <button type="button" title="save this message as an Obsidian note" onClick={() => p.onSaveMsg!(messageToText(m))}
                          style={{ fontFamily: "inherit", fontSize: 9, letterSpacing: 1, background: "transparent", color: "#A78BFA", border: "1px solid #2A2A38", padding: "3px 8px", cursor: "pointer" }}>
                          ⬇ SAVE TO VAULT
                        </button>
                      </div>
                    )
                )}
              </div>
            );
          })}
        </div>
        {unseen && !atBottom && (
          <button type="button" onClick={jumpToBottom}
            style={{ position: "absolute", bottom: 10, left: "50%", transform: "translateX(-50%)", fontFamily: MONO, fontSize: 10, letterSpacing: 1, background: "#22D3EE", color: "#0D0D12", border: 0, borderRadius: 12, padding: "5px 12px", cursor: "pointer", boxShadow: "0 6px 16px rgba(0,0,0,0.5)" }}>
            ↓ new message
          </button>
        )}
      </div>
      <div style={{ borderTop: "2px solid #2A2A38", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, flex: "0 0 auto" }}>
        <AttachBar attachments={p.attachments} onRemove={p.onRemoveAttachment} />
        <ChatInput value={p.draft} onChange={p.onDraft} onSubmit={p.onSend} commands={p.commands} requestFiles={p.requestFiles} tabId={p.activeTabId} onAddFiles={p.onAddFiles} canImage={p.canImage} canDoc={p.canDoc} mobile={p.mobile} />
        {/* On mobile SEND lives inside the input row; keep only the context line here. */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontSize: 9, letterSpacing: 1, color: "#6B6B7B" }}>{model.ctxLine}</span>
          {!p.mobile && <button type="button" onClick={p.onSend} style={{ fontFamily: "inherit", fontSize: 10, letterSpacing: 2, background: "#22D3EE", color: "#0D0D12", border: 0, padding: "7px 16px", cursor: "pointer" }}>SEND</button>}
        </div>
      </div>
    </>
  );
}

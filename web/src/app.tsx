import { useEffect, useRef, useState } from "react";
import { useDomSocket, GLOBAL_TAB } from "./store";
import { SessionsFloor, zoneLabel, type ChatMsg, type SelDetail } from "./SessionsFloor";
import { StreamDiff } from "./StreamDiff";
import { DesignPanel } from "./DesignPanel";
import { KanbanBoard } from "./KanbanBoard";
import type { KanbanColumn } from "./kanban";
import { QrPopover, type QrCode } from "./QrPopover";
import { WebhooksBody } from "./WebhooksPanel";
import { classifyNote, noteSlug } from "./notesort.js";
import { tokenizedUrl, token, fileUrlFor } from "./api";
import { notify as webNotify, pageHidden } from "./notify";
import type { TaskMode } from "./NewTaskSheet";
import { OverlayModal } from "./OverlayModal";
import { Sidebar } from "./Sidebar";
import { VaultSaveModal } from "./VaultSaveModal";
import { GoalBar } from "./GoalBar";
import { BackgroundPanel } from "./BackgroundPanel";
import { TerminalDock } from "./Terminal";
import { apiGet } from "./api";
import type { VaultTree } from "./filetypes";
import type { ConnectionsData, MemoryData } from "./types";
import { floorFigures, sessionsModel, planOfficePlacement, STATE_COLOR } from "./sessions.js";
import { TopBar, shellBridge } from "./TopBar";
import { UpdateToast } from "./UpdateToast";
import { toolList, toolStats, sparkline } from "./telemetry.js";
import { groupChat } from "./chatgroups.js";
import type { Attachment } from "./types";
import type { FigState, ManualAgent, ZoneId } from "./sessions";
import { ManualAgentPopover } from "./ManualAgentPopover";
import { Z } from "./layers";

// Manual agents live only in this browser session: mirrored to localStorage so
// they survive React churn, but cleared on a real page refresh.
const MANUAL_KEY = "dom-manual-agents";

// Guess a MIME type from the filename when the browser doesn't supply one.
function guessMime(name: string): string {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv",
  };
  return map[ext] ?? "application/octet-stream";
}

// Read a File to base64 (no data: prefix) for sending as a content block.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(",") + 1)); };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function App() {
  const { state, send, select, requestFiles, saveVault } = useDomSocket();
  const [selFig, setSelFig] = useState<string | null>(null);
  // Reactive viewport width so the terminal dock (a desktop affordance) is hidden on
  // phones — the mobile layout has no terminal.
  const [vw, setVw] = useState(typeof window !== "undefined" ? window.innerWidth : 1200);
  useEffect(() => { const on = () => setVw(window.innerWidth); window.addEventListener("resize", on); return () => window.removeEventListener("resize", on); }, []);
  const isMobile = vw < 640;
  // Top-level view: the office FLOOR (default) or the KANBAN board.
  const [view, setView] = useState<"floor" | "kanban">("floor");
  // Client-only kanban column overrides (ACTIVE/PARKED); REVIEW is derived from plan
  // mode and DONE closes the session, so neither is stored here.
  const [kanbanOverrides, setKanbanOverrides] = useState<Record<number, string>>({});
  const [draft, setDraft] = useState("");
  const [steer, setSteer] = useState("");
  // Files staged for the next message (base64 content blocks). Cleared on send.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // The Obsidian vault tree (md-only). Fetched once and re-fetched whenever a note
  // may have changed (vaultEpoch: tool.end or a "save to vault"). Drives both the
  // OBSIDIAN panel tab and the chat rail's "save to vault" button.
  const [vault, setVault] = useState<VaultTree | null>(null);
  const [saveTarget, setSaveTarget] = useState<string | null>(null);
  useEffect(() => { void apiGet<VaultTree>("/api/vault/tree").then(setVault); }, [state.vaultEpoch]);

  // Phone notifications. The desktop notifier fires on the machine running
  // Gnosis, not in the pocket of whoever assigned the task — so the browser
  // raises its own when something needs an answer, but only when the page is not in
  // front of the user — otherwise the card in the rail is the notification.
  const pendingRef = useRef<string | null>(null);
  useEffect(() => {
    const waiting = state.chatLines.filter((l) => (l.kind === "ask" && !l.answered) || (l.kind === "approval" && !l.resolved)).slice(-1)[0];
    const key = waiting ? `${waiting.kind}:${waiting.key}` : null;
    if (key && key !== pendingRef.current && pageHidden()) {
      webNotify("Gnosis needs you", waiting!.kind === "ask" ? (waiting!.question ?? "a question") : (waiting!.label ?? "approval required"));
    }
    pendingRef.current = key;
  }, [state.chatLines]);
  // CONNECTIONS tab data (MCP servers, keys, skills, HTTP jobs). Re-fetched when
  // connectionsEpoch bumps (mcp toggle / job start-end).
  const [connections, setConnections] = useState<ConnectionsData | null>(null);
  const refreshConnections = () => { void apiGet<ConnectionsData>("/api/connections").then(setConnections); };
  useEffect(() => { refreshConnections(); }, [state.connectionsEpoch]);
  // MEMORY panel data (automatic learned context). Shares the connectionsEpoch so a
  // memory.clear (which emits connections.changed) re-fetches it.
  const [memory, setMemory] = useState<MemoryData | null>(null);
  const refreshMemory = () => { void apiGet<MemoryData>("/api/memory").then(setMemory); };
  useEffect(() => { refreshMemory(); }, [state.connectionsEpoch]);
  const [, bump] = useState(0);
  const debugRef = useRef<{ byFloor: Record<number, any[]>; userCb: ((m: any) => void) | null; approvalCb: ((m: any) => void) | null }>({ byFloor: {}, userCb: null, approvalCb: null });

  // Decorative manual agents placed on desks (client-only, cleared on refresh).
  const [manuals, setManuals] = useState<ManualAgent[]>([]);
  const [manualEditor, setManualEditor] = useState<{ mode: "add"; zone: ZoneId; slot: number } | { mode: "edit"; agent: ManualAgent } | null>(null);
  useEffect(() => { try { localStorage.removeItem(MANUAL_KEY); } catch { /* private mode */ } }, []);
  useEffect(() => { try { localStorage.setItem(MANUAL_KEY, JSON.stringify(manuals)); } catch { /* quota/private */ } }, [manuals]);

  // Present only inside the Electron shell (electron/shell-preload.cjs). In a
  // browser this is null and the app keeps the browser's own chrome.
  const shell = shellBridge();
  useEffect(() => {
    if (!shell) return;
    document.documentElement.classList.add("gnosis-shell");
    return () => document.documentElement.classList.remove("gnosis-shell");
  }, [shell]);

  const activeId = state.selected != null && state.agents[state.selected] ? state.selected : state.order[0] ?? null;
  const model = sessionsModel(state, activeId, selFig, debugRef.current.byFloor, manuals);
  // The freshest layout, readable from callbacks/effects that must not re-bind on
  // every manual-agent change (window.gnosisOffice, the office.place handler).
  const layoutRef = useRef(model.layout);
  layoutRef.current = model.layout;

  // Design-mode before/after panel: dismissable per shot (a new capture reappears).
  const [dismissedShot, setDismissedShot] = useState<string | null>(null);
  const activeShot = activeId != null ? state.designShots[activeId] ?? null : null;
  const showShot = activeShot && activeShot.after !== dismissedShot ? activeShot : null;

  // A real/debug figure claimed a manual desk → drop the manual silently.
  const takenOver = model.layout.takenOverManualIds;
  useEffect(() => {
    if (takenOver.length) setManuals((ms) => ms.filter((m) => !takenOver.includes(m.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takenOver.join(",")]);

  const addManual = (zone: ZoneId, slot: number, name: string, figState: FigState) =>
    setManuals((ms) => [...ms, { id: `manual:${Date.now()}-${Math.round(Math.random() * 1e6)}`, name, zone, slot, state: figState }]);
  const updateManual = (id: string, patch: Partial<ManualAgent>) => setManuals((ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  const removeManual = (id: string) => setManuals((ms) => ms.filter((m) => m.id !== id));
  // Seat a placement request on whatever desks are free. The bus (and the console
  // helpers) carry the request unresolved — zone null = every zone, count null =
  // fill to capacity — because only the floor knows which desks are taken.
  const placeAgents = (req: { zone: string | null; count: number | null; names: string[]; state: string }) =>
    setManuals((ms) => [...ms, ...planOfficePlacement(req, layoutRef.current.placed, ms, Date.now())]);

  // The model staffing the floor from chat: the `office` tool emits office.place /
  // office.clear and the store stamps each with a seq. Drain every request past the
  // last one applied — a fresh connect replays the ring, so they arrive in bursts
  // and taking only the newest would silently drop the rest.
  const officeSeqRef = useRef(0);
  useEffect(() => {
    const pending = state.officeQueue.filter((r) => r.seq > officeSeqRef.current);
    if (!pending.length) return;
    officeSeqRef.current = pending[pending.length - 1]!.seq;
    for (const req of pending) {
      if (req.action === "clear") setManuals([]);
      else placeAgents(req);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.officeQueue]);
  // The store threw the whole picture away (serve stopped, or we reconnected to a
  // different server). Everything it does not own has to go with it, or the floor
  // keeps drawing figures — manual and debug ones outlive any agent event — for a
  // session that is gone. officeSeqRef is rewound too: a fresh server's seq starts
  // at 0 again, so a cursor left at the old server's high-water mark would swallow
  // every placement the new one asks for.
  useEffect(() => {
    if (state.floorEpoch === 0) return; // no reset has happened yet
    setManuals([]);
    debugRef.current.byFloor = {};
    officeSeqRef.current = 0;
    setSelFig(null);
    setDismissedShot(null);
    try { localStorage.removeItem(MANUAL_KEY); } catch { /* private mode */ }
  }, [state.floorEpoch]);

  // Clicking a manual figure edits it; any other figure selects it as before.
  const onSelectFig = (id: string | null) => {
    if (id && id.startsWith("manual:")) { const m = manuals.find((x) => x.id === id); if (m) setManualEditor({ mode: "edit", agent: m }); return; }
    setSelFig(id);
  };
  const onDeskClick = (zone: ZoneId, slot: number) => setManualEditor({ mode: "add", zone, slot });

  const sendTo = (id: number, text: string) =>
    text.startsWith("/") ? send({ type: "command", tabId: id, command: text }) : send({ type: "input", tabId: id, text });

  // window.gnosisOffice — debug overlay (add/update/think/remove/list/say/setFloor/addFloor).
  useEffect(() => {
    const fu = () => bump((n) => n + 1);
    const floorOf = (fid?: number) => (fid != null ? fid : activeId) ?? 0;
    const api = {
      add: (a: any, fid?: number) => { const f = floorOf(fid ?? a?.floor); (debugRef.current.byFloor[f] ||= []).push({ id: a?.id ?? `dbg-${Date.now()}`, name: a?.name ?? "dbg", zone: a?.zone ?? "coding", state: a?.state ?? "thinking", action: a?.action ?? "booting", output: a?.output ?? [], thinking: a?.thinking ?? ["debug agent"] }); fu(); },
      update: (id: any, patch: any) => { for (const f of Object.values(debugRef.current.byFloor)) for (const x of f as any[]) if (x.id === id) Object.assign(x, patch); fu(); },
      think: (id: any, line: string) => { for (const f of Object.values(debugRef.current.byFloor)) for (const x of f as any[]) if (x.id === id) x.thinking = (x.thinking || []).concat([line]); fu(); },
      remove: (id: any) => { for (const k of Object.keys(debugRef.current.byFloor)) debugRef.current.byFloor[Number(k)] = debugRef.current.byFloor[Number(k)].filter((x) => x.id !== id); fu(); },
      list: (fid?: number) => floorFigures(state, floorOf(fid)),
      say: (m: any) => { if (debugRef.current.userCb) debugRef.current.userCb(m); },
      setFloor: (id: number) => { select(id); setSelFig(null); },
      addFloor: () => send({ type: "agent.create" }),
      floors: () => state.order.map((id) => ({ id, name: state.agents[id]?.name })),
      // The same placement the `office` tool drives, from the console:
      //   gnosisOffice.fill()            — every zone to capacity
      //   gnosisOffice.fill("coding")    — one zone to capacity
      //   gnosisOffice.place("coding", 5, { names: [...], state: "thinking" })
      place: (zone?: string | null, count?: number | null, opts?: { names?: string[]; state?: string }) =>
        placeAgents({ zone: zone ?? null, count: count ?? null, names: opts?.names ?? [], state: opts?.state ?? "mixed" }),
      fill: (zone?: string | null) => placeAgents({ zone: zone ?? null, count: null, names: [], state: "mixed" }),
      clearFloor: () => setManuals([]),
      onUserMessage: (cb: any) => { debugRef.current.userCb = cb; },
      onApproval: (cb: any) => { debugRef.current.approvalCb = cb; },
    };
    // gnosisOffice is the current name. domOffice and domThree stay as aliases of
    // the SAME object so existing wiring keeps working across the rename — the
    // same back-compat promise the `dom` bin alias makes.
    const names = ["gnosisOffice", "domOffice", "domThree"];
    for (const n of names) (window as any)[n] = api;
    return () => {
      for (const n of names) if ((window as any)[n] === api) delete (window as any)[n];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, activeId]);

  // Selected-figure detail for the popup.
  const figs = activeId != null ? floorFigures(state, activeId) : [];
  const selF = figs.find((f) => f.id === selFig) || null;
  const selTele = selF ? state.telemetry[selF.tabId] : undefined;
  const selToolStats = toolStats(selTele);
  const sel: SelDetail | null = selF
    ? {
        id: selF.id, name: selF.name, zone: zoneLabel(selF.zone), color: model.layout.colorById[selF.id] ?? "#C9C9D6", stateColor: STATE_COLOR[selF.state] ?? "#6B6B7B", state: selF.state, action: selF.action, output: selF.output, thinking: selF.thinking, awaiting: selF.state === "awaiting",
        tele: {
          tokens: selTele?.tokens ?? 0,
          cachedTokens: selTele?.cachedTokens ?? 0,
          turns: selTele?.turns ?? 0,
          tools: toolList(selTele),
          total: selToolStats.total,
          successRate: selToolStats.successRate,
          spark: sparkline(selTele?.tokensSeries ?? []),
          turnStart: selTele?.turnStart ?? null,
        },
      }
    : null;

  // Auto-save to Obsidian: after a turn ends, if the vault is configured and the
  // response looks worth keeping (a code fence, a markdown table, or > 200 words),
  // save it automatically under a slug from the first line + today's date, and mark
  // that turn so the chat shows "auto-saved" instead of the SAVE TO VAULT button.
  const savedTurnsRef = useRef<Set<string>>(new Set());
  // Maps turn id → the vault-relative path it was auto-saved to (shown in the rail).
  const [savedTurns, setSavedTurns] = useState<Record<string, string>>({});
  const endedEpoch = activeId != null ? (state.turnEpoch[activeId] ?? 0) - 1 : -1;
  useEffect(() => {
    if (activeId == null || !vault?.configured || endedEpoch < 0) return;
    const id = `${activeId}:${endedEpoch}`;
    if (savedTurnsRef.current.has(id)) return;
    savedTurnsRef.current.add(id);
    const lines = state.chatLines.filter((l) => l.tabId === activeId && l.epoch === endedEpoch);
    const text = lines.filter((l) => l.kind === "assistant" && l.text).map((l) => l.text!).join("\n").trim();
    const userMessage = lines.filter((l) => l.kind === "user" && l.text).map((l) => l.text!).join(" ");
    const hasCode = lines.some((l) => l.rule); // a ─── code fence in this turn
    // Intent-based routing: Code/ · Research/ · Decisions/ · or don't save.
    const verdict = classifyNote({ text, hasCode, userMessage });
    if (!verdict.save) return;
    const date = new Date().toISOString().slice(0, 10);
    void saveVault(`${noteSlug(text)}-${date}`, ["auto-saved"], text, verdict.folder).then((r) => { if (r.ok && r.path) setSavedTurns((p) => ({ ...p, [id]: r.path! })); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, vault?.configured, endedEpoch]);

  // Chat = this floor's feed, grouped into per-speaker/per-turn message blocks
  // (line events + code fences + approval requests).
  const tabColor = (activeId != null ? model.layout.colorById[`tab:${activeId}`] : undefined) ?? "#6B6B7B";
  // GLOBAL_TAB lines (the reconnect notice) belong to no session, so they show
  // alongside whichever one is selected — and still show when none is.
  const rawLines = state.chatLines.filter((l) => l.tabId === GLOBAL_TAB || (activeId != null && l.tabId === activeId));
  const epochByKey: Record<string, number> = {};
  for (const l of rawLines) epochByKey[l.key] = l.epoch;
  const chat: ChatMsg[] = groupChat(rawLines)
    .slice(-40)
    .map((g) => {
      const pending = g.isApproval && !!state.permission && state.permission.id === g.permId && !g.resolved;
      const border = g.resolved ? (g.resolved === "no" ? "#F87171" : "#4ADE80") : g.isApproval ? "#FBBF24" : "#2C2C3E";
      return {
        key: g.key, from: g.from, time: g.time, kind: g.kind, segments: g.segments,
        color: g.from === "YOU" ? "#C9C9D6" : tabColor,
        border,
        isApproval: pending,
        permId: g.permId,
        resolved: g.resolved,
        tool: g.tool,
        verdict: g.verdict,
        confidence: g.confidence,
        fileOutput: g.fileOutput,
        askId: g.askId,
        options: g.options,
        answered: g.answered,
        autoSaved: g.kind === "assistant" ? savedTurns[`${activeId}:${epochByKey[g.key]}`] : undefined,
      };
    });

  const answer = (a: string) => { if (state.permission) send({ type: "permission", id: state.permission.id, answer: a }); if (debugRef.current.approvalCb) debugRef.current.approvalCb({ approved: a !== "no" }); };
  const answerId = (permId: string | undefined, a: string) => { if (permId) send({ type: "permission", id: permId, answer: a }); };
  const answerAsk = (askId: string | undefined, text: string) => { if (askId) send({ type: "ask.answer", id: askId, answer: text }); };

  /**
   * The phone composer's two verbs, each mapped to what already exists:
   * a normal turn, or a read-only research sub-agent.
   */
  const onNewTask = (text: string, mode: TaskMode) => {
    if (activeId == null) return;
    if (mode === "research") send({ type: "input", tabId: activeId, text: `Research this and reply with a summary — do not edit any files:

${text}` });
    else send({ type: "input", tabId: activeId, text });
    // The rail already shows what happened next — the turn starts streaming — so
    // the status of what you just handed over is visible without moving the user
    // anywhere.
  };

  const activeAgent = activeId != null ? state.agents[activeId] ?? null : null;
  const canImage = !!activeAgent?.imageInput;
  const canDoc = !!activeAgent?.documentInput;

  const onSend = () => {
    const t = draft.trim();
    if (activeId == null) return;
    if (!t && attachments.length === 0) return;
    if (t.startsWith("/")) { send({ type: "command", tabId: activeId, command: t }); setDraft(""); return; }
    send({ type: "input", tabId: activeId, text: t, attachments: attachments.length ? attachments : undefined });
    if (debugRef.current.userCb) debugRef.current.userCb({ text: t, floor: activeId });
    setDraft("");
    setAttachments([]);
  };
  const onSteer = () => { const t = steer.trim(); if (t && selF) sendTo(selF.tabId, t); setSteer(""); };
  // Attach a browsed file to the next message: drop an @-reference into the draft
  // (the same @path mechanism the composer + backend already resolve).
  const attachFile = (p: string) => setDraft((d) => (d.trim() ? d.replace(/\s*$/, "") + " " : "") + "@" + p + " ");

  // Stage dropped/picked files as base64 content blocks. Images and PDFs are gated
  // on the active model's modalities; text files are always allowed (inlined later).
  const addFiles = async (files: File[]) => {
    const staged: Attachment[] = [];
    for (const f of files) {
      const mime = f.type || guessMime(f.name);
      if (mime.startsWith("image/") && !canImage) continue;
      if (mime === "application/pdf" && !canDoc) continue;
      try { staged.push({ name: f.name, mime, data: await fileToBase64(f) }); } catch { /* skip unreadable file */ }
    }
    if (staged.length) setAttachments((a) => [...a, ...staged]);
  };
  const removeAttachment = (i: number) => setAttachments((a) => a.filter((_, k) => k !== i));

  // Kanban: move a session between columns. REVIEW ⇒ read-only plan mode; DONE ⇒
  // close after confirm; ACTIVE/PARKED are UI-only (and leave plan mode if set).
  const moveKanban = (tabId: number, column: KanbanColumn) => {
    if (column === "done") {
      if (window.confirm(`Close session "${state.agents[tabId]?.name ?? tabId}"? This ends it.`)) send({ type: "agent.close", tabId });
      return;
    }
    if (column === "review") {
      send({ type: "command", tabId, command: "/mode plan" });
      setKanbanOverrides((o) => ({ ...o, [tabId]: "review" }));
      return;
    }
    if (state.agents[tabId]?.mode === "plan") send({ type: "command", tabId, command: "/mode ask" });
    setKanbanOverrides((o) => ({ ...o, [tabId]: column }));
  };
  const openFromKanban = (tabId: number) => { select(tabId); setSelFig(null); setView("floor"); };

  // Serve status + QR. The LOCAL url is this page's own tokenized URL; PUBLIC (when
  // /serve --public is up) comes from the bus (serve.public), falling back to
  // /api/serveinfo for clients that connected before the tunnel came up.
  const [serveInfo, setServeInfo] = useState<{ public: string | null; lan?: string | null } | null>(null);
  useEffect(() => { void apiGet<{ public: string | null; lan?: string | null }>("/api/serveinfo").then(setServeInfo); }, [state.publicUrl]);
  const publicBase = state.publicUrl ?? serveInfo?.public ?? null;
  const localTokenUrl = typeof location !== "undefined" ? tokenizedUrl(location.origin) : "";
  const publicTokenUrl = publicBase ? `${publicBase.replace(/\/$/, "")}/?token=${token()}` : null;
  const lanTokenUrl = serveInfo?.lan ? `${serveInfo.lan.replace(/\/$/, "")}/?token=${token()}` : null;
  const [serveMenu, setServeMenu] = useState(false);
  // The terminal dock's open state lives here so its toggle can sit in the chrome
  // band with FLOOR/KANBAN/SERVE instead of floating over the page's bottom-left.
  const [terminalOpen, setTerminalOpen] = useState(false);

  // The shell's listeners are bound once and live for the window's lifetime, so
  // they read the active agent through a ref rather than closing over a value
  // that was current only at mount.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  // --- desktop shell integration -------------------------------------------
  // All of this is a no-op in a browser: `shell` is null and every effect below
  // returns immediately.

  // UI state lives in the main process, not localStorage: the desktop app is
  // served from an ephemeral port, so its origin — and its localStorage — is
  // different on every launch.
  const uiRestored = useRef(false);
  useEffect(() => {
    if (!shell || uiRestored.current) return;
    uiRestored.current = true;
    void shell.getUiState().then((ui) => {
      if (typeof ui?.terminalOpen === "boolean") setTerminalOpen(ui.terminalOpen);
      if (ui?.view === "kanban" || ui?.view === "floor") setView(ui.view);
    });
  }, [shell]);
  useEffect(() => { shell?.setUiState({ terminalOpen, view }); }, [shell, terminalOpen, view]);

  // Keyboard shortcuts, dispatched from the main process's accelerator table.
  useEffect(() => {
    if (!shell) return;
    return shell.onShortcut((action) => {
      const id = activeIdRef.current;
      switch (action) {
        case "new-session": if (id != null) send({ type: "command", tabId: id, command: "/new" }); break;
        case "new-terminal": setTerminalOpen(true); break;
        case "model-picker": if (id != null) send({ type: "command", tabId: id, command: "/model" }); break;
        case "clear-chat": if (id != null) send({ type: "command", tabId: id, command: "/clear" }); break;
        case "screenshot": if (id != null) send({ type: "input", tabId: id, text: "Take a screenshot of my screen with the computer tool and describe it." }); break;
        case "escape": setQr(null); setServeMenu(false); setTerminalOpen(false); break;
        default: break;
      }
    });
  }, [shell]);

  // gnosis:// links.
  useEffect(() => {
    if (!shell) return;
    return shell.onDeepLink((d) => {
      const id = activeIdRef.current;
      if (d.action === "session" && d.name) send({ type: "command", tabId: id ?? 0, command: `/new ${d.name}` });
      else if (d.action === "file" && d.path) setDraft((t) => (t.trim() ? t.replace(/\s*$/, "") + " " : "") + "@" + d.path + " ");
      // "serve" needs nothing: reaching this renderer at all means it is serving.
    });
  }, [shell]);

  // Clicking a toast focuses the agent that raised it.
  useEffect(() => {
    if (!shell) return;
    return shell.onNotificationActivate((p) => {
      if (typeof p?.tabId === "number") { select(p.tabId); setSelFig(null); }
    });
  }, [shell]);

  // Native right-click menu commands come back here to be acted on.
  useEffect(() => {
    if (!shell) return;
    return shell.onMenuCommand(({ command, payload }) => {
      const id = activeIdRef.current;
      const tabId = typeof payload?.tabId === "number" ? (payload.tabId as number) : id;
      switch (command) {
        case "zone.add":
          if (id != null) send({ type: "command", tabId: id, command: `/new agent in ${payload.zone}` });
          break;
        case "zone.fill":
          if (id != null) send({ type: "input", tabId: id, text: `Fill the ${payload.zone} zone with agents.` });
          break;
        case "floor.clear":
          if (id != null) send({ type: "input", tabId: id, text: "Clear the floor." });
          break;
        case "agent.open":
        case "agent.message":
          // Both land you in that agent's rail; "send message" just puts the
          // cursor where you would type it.
          if (tabId != null) { select(tabId); setSelFig(null); }
          break;
        case "agent.remove":
          // Same confirmation the close button uses — a right-click should not
          // be able to end a session in one click.
          if (tabId != null && window.confirm(`Close session "${state.agents[tabId]?.name ?? tabId}"? This ends it.`)) {
            send({ type: "agent.close", tabId });
          }
          break;
        case "file.open":
        case "file.attach":
          if (typeof payload?.path === "string") attachFile(payload.path as string);
          break;
        default: break; // copyPath / reveal are handled in the main process
      }
    });
  }, [shell]);

  const [qr, setQr] = useState<{ title: string; codes: QrCode[] } | null>(null);
  // Every reachable URL, in one list. LOCAL and LAN are both always available (LAN
  // needs no flag — the token is the gate); PUBLIC appears only with a live tunnel.
  const allCodes: QrCode[] = [
    { title: "LOCAL · this machine", url: localTokenUrl, color: "#22D3EE" },
    ...(lanTokenUrl ? [{ title: "LAN · same WiFi", url: lanTokenUrl, color: "#FBBF24" }] : []),
    ...(publicTokenUrl ? [{ title: "PUBLIC · tunnel", url: publicTokenUrl, color: "#4ADE80" }] : []),
  ];
  const chip = (label: string, active: boolean, onClick: () => void, leftEdge: boolean) => (
    <button type="button" data-testid={`chip-${label.replace(/[^A-Za-z]/g, "").toLowerCase()}`} onClick={onClick} style={{ fontFamily: "inherit", fontSize: 9, letterSpacing: 2, padding: "5px 10px", cursor: "pointer", background: active ? "#23232F" : "#121219", color: active ? "#22D3EE" : "#6B6B7B", border: "2px solid #2C2C3E", borderLeft: leftEdge ? "2px solid #2C2C3E" : 0 }}>{label}</button>
  );
  const qrItem = (label: string, color: string, codes: QrCode[], title: string, last: boolean) => (
    <button type="button" onClick={() => { setQr({ title, codes }); setServeMenu(false); }} style={{ fontFamily: "inherit", fontSize: 9, letterSpacing: 2, textAlign: "left", padding: "6px 10px", cursor: "pointer", background: "transparent", color, border: 0, borderBottom: last ? 0 : "1px solid #2C2C3E" }}>{label}</button>
  );

  const makeViewToggle = (docked: boolean) => (
    <div data-testid="view-toggle" style={docked
      ? { position: "relative", display: "flex", flexDirection: "column", alignItems: "flex-start", fontFamily: "'JetBrains Mono', ui-monospace, monospace" }
      : { position: "fixed", top: 10, right: 14, zIndex: Z.chrome, display: "flex", flexDirection: "column", alignItems: "flex-end", fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
      <div style={{ display: "flex" }}>
        {chip("FLOOR", view === "floor", () => setView("floor"), true)}
        {chip("KANBAN", view === "kanban", () => setView("kanban"), false)}
        {chip("◆ SERVE", serveMenu, () => setServeMenu((o) => !o), false)}
        {view === "floor" && !isMobile && chip("▸_ TERMINAL", terminalOpen, () => setTerminalOpen((o) => !o), false)}
      </div>
      {serveMenu && (
        <div style={{ position: "absolute", top: "100%", marginTop: 4, zIndex: Z.chrome, background: "#0D0D12", border: "2px solid #2C2C3E", display: "flex", flexDirection: "column", minWidth: 132 }}>
          {qrItem("ALL · QR", "#C9C9D6", allCodes, "SERVE URLS", false)}
          {allCodes.map((c, i) => qrItem(`${c.title.split(" · ")[0]} · QR`, c.color, [c], c.title.toUpperCase(), i === allCodes.length - 1))}
        </div>
      )}
    </div>
  );
  // Floating over the page for the kanban view, in the floor header for the
  // floor view — the redesign puts the tabs at the top of the centre column.
  const viewToggle = makeViewToggle(false);
  const dockedViewToggle = makeViewToggle(true);
  const topBar = shell ? (
    <TopBar
      shell={shell}
      modelId={activeId != null ? state.agents[activeId]?.model ?? null : null}
      costLine={model.costLine}
      awaitingLine={model.awaitingLine}
      globalLine={model.globalLine}
      awaiting={!model.awaitingLine.startsWith("0 ")}
    />
  ) : null;
  const qrPopover = qr ? <QrPopover title={qr.title} codes={qr.codes} onClose={() => setQr(null)} /> : null;

  if (view === "kanban") {
    return (
      <>
        {topBar}
        {shell && <UpdateToast shell={shell} />}
        {viewToggle}
        {qrPopover}
        <KanbanBoard state={state} overrides={kanbanOverrides} onMove={moveKanban} onOpen={openFromKanban} />
        {state.overlay && (
          <OverlayModal key={state.overlay.id} overlay={state.overlay} onSelect={(value) => send({ type: "overlay.select", id: state.overlay!.id, value })} onCancel={() => send({ type: "overlay.cancel", id: state.overlay!.id })} />
        )}
      </>
    );
  }

  return (
    <>
      {topBar}
      {shell && <UpdateToast shell={shell} />}
      {qrPopover}
      <SessionsFloor
        viewTabs={dockedViewToggle}
        model={model}
        chat={chat}
        sel={sel}
        draft={draft}
        steer={steer}
        commands={state.commands}
        activeTabId={activeId}
        requestFiles={requestFiles}
        goalText={activeId != null ? state.goals[activeId]?.text ?? null : null}
        onViewActivity={() => setView("floor")}
        onSelectFloor={(id) => { select(id); setSelFig(null); }}
        onAgentContext={shell ? (d) => shell.showMenu("agent", { ...d }) : undefined}
        onZoneContext={shell ? (d) => shell.showMenu("zone", { ...d }) : undefined}
        onAddFloor={() => send({ type: "agent.create" })}
        onSelectFig={onSelectFig}
        onDeskClick={onDeskClick}
        onClose={() => setSelFig(null)}
        onApprove={() => answer("yes")}
        onDeny={() => answer("no")}
        onDismiss={() => { if (selF?.kind === "tab") send({ type: "agent.close", tabId: selF.tabId }); setSelFig(null); }}
        onSteer={onSteer}
        onSteerDraft={setSteer}
        onDraft={setDraft}
        onSend={onSend}
        attachments={attachments}
        onAddFiles={addFiles}
        onRemoveAttachment={removeAttachment}
        canImage={canImage}
        canDoc={canDoc}
        onAnswerAsk={answerAsk}
        onRunBackground={(text) => activeId != null && send({ type: "agent.background", tabId: activeId, text })}
        busy={activeId != null && !!state.agents[activeId]?.busy}
        onStop={() => activeId != null && send({ type: "agent.stop", tabId: activeId })}
        onNewTask={onNewTask}
        onFixOutcome={() => activeId != null && send({ type: "command", tabId: activeId, command: "/fix" })}
        fileUrl={(path, raw) => fileUrlFor(activeId ?? 0, path, raw)}
        onApproveMsg={(permId) => answerId(permId, "yes")}
        onDenyMsg={(permId) => answerId(permId, "no")}
        goalBar={
          <GoalBar
            goal={activeId != null ? state.goals[activeId] ?? null : null}
            review={activeId != null ? state.reviews[activeId] ?? null : null}
            disabled={activeId == null}
            onSet={(g) => { if (activeId != null) send({ type: "goal.set", tabId: activeId, ...g }); }}
            onClear={() => { if (activeId != null) send({ type: "goal.clear", tabId: activeId }); }}
          />
        }
        plan={activeId != null ? state.plans[activeId] ?? null : null}
        designPanel={showShot ? <DesignPanel shot={showShot} onClose={() => setDismissedShot(showShot.after)} /> : null}
        streamPanel={
          activeId != null && state.streamEdits[activeId]
            ? <StreamDiff edit={state.streamEdits[activeId]!} onUndo={() => send({ type: "command", tabId: activeId, command: "/undo" })} />
            : null
        }
        canSaveVault={!!vault?.configured}
        onSaveMsg={(content) => setSaveTarget(content)}
        leftPanel={
          <Sidebar
            project={(() => {
              const cwd = activeId != null ? state.agents[activeId]?.cwd ?? "" : "";
              // Windows paths use backslashes, POSIX forward — split on either.
              return cwd.split(/[\\/]/).filter(Boolean).slice(-1)[0] || "workspace";
            })()}
            tabId={activeId}
            fileEpoch={state.fileEpoch}
            vault={vault}
            connections={connections}
            memory={memory}
            onAttach={attachFile}
            onRefreshVault={() => void apiGet<VaultTree>("/api/vault/tree").then(setVault)}
            onRefreshConnections={() => { refreshConnections(); refreshMemory(); }}
            onToggleMcp={(name, enabled) => send({ type: "mcp.toggle", name, enabled })}
            onClearMemory={() => send({ type: "memory.clear" })}
            webhookEpoch={state.webhookEpoch}
            onNewSession={() => activeId != null && send({ type: "command", tabId: activeId, command: "/new" })}
            sessions={state.order.map((id) => ({
              id,
              name: state.agents[id]?.name ?? String(id),
              state: state.agents[id]?.busy ? "busy" : "idle",
              color: id === activeId ? "#22D3EE" : "#2C2C3E",
            }))}
            onSelectSession={(id) => { select(id); setSelFig(null); }}
          />
        }
        rightPanel={<BackgroundPanel jobEpoch={state.jobEpoch} send={send} />}
        webhooksPanel={<WebhooksBody webhookEpoch={state.webhookEpoch} localOrigin={typeof location !== "undefined" ? location.origin : ""} />}
      />
      {saveTarget != null && (
        <VaultSaveModal content={saveTarget} onSave={saveVault} onClose={() => setSaveTarget(null)} />
      )}
      {manualEditor && (
        <ManualAgentPopover
          mode={manualEditor.mode}
          zone={manualEditor.mode === "add" ? manualEditor.zone : manualEditor.agent.zone}
          slot={manualEditor.mode === "add" ? manualEditor.slot : manualEditor.agent.slot}
          defaultName={`agent-${manuals.length + 1}`}
          agent={manualEditor.mode === "edit" ? manualEditor.agent : undefined}
          onAdd={(name, figState) => { if (manualEditor.mode === "add") addManual(manualEditor.zone, manualEditor.slot, name, figState); }}
          onUpdate={(patch) => { if (manualEditor.mode === "edit") updateManual(manualEditor.agent.id, patch); }}
          onRemove={() => { if (manualEditor.mode === "edit") removeManual(manualEditor.agent.id); }}
          onClose={() => setManualEditor(null)}
        />
      )}
      {state.overlay && (
        <OverlayModal
          key={state.overlay.id}
          overlay={state.overlay}
          onSelect={(value) => send({ type: "overlay.select", id: state.overlay!.id, value })}
          onCancel={() => send({ type: "overlay.cancel", id: state.overlay!.id })}
        />
      )}
      {!isMobile && <TerminalDock tabId={activeId} open={terminalOpen} onClose={() => setTerminalOpen(false)} />}
    </>
  );
}

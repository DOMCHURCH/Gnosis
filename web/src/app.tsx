import { useEffect, useRef, useState } from "react";
import { useDomSocket } from "./store";
import { SessionsFloor, zoneLabel, type ChatMsg, type SelDetail } from "./SessionsFloor";
import { OverlayModal } from "./OverlayModal";
import { LeftPanel } from "./LeftPanel";
import { VaultSaveModal } from "./VaultSaveModal";
import { GoalBar } from "./GoalBar";
import { BackgroundPanel } from "./BackgroundPanel";
import { TerminalDock } from "./Terminal";
import { apiGet } from "./api";
import type { VaultTree } from "./filetypes";
import type { ConnectionsData } from "./types";
import { floorFigures, sessionsModel, STATE_COLOR } from "./sessions.js";
import { groupChat } from "./chatgroups.js";
import type { Attachment } from "./types";
import type { FigState, ManualAgent, ZoneId } from "./sessions";
import { ManualAgentPopover } from "./ManualAgentPopover";
import { TooltipProvider } from "@/components/ui/tooltip";

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
  // CONNECTIONS tab data (MCP servers, keys, skills, HTTP jobs). Re-fetched when
  // connectionsEpoch bumps (mcp toggle / job start-end).
  const [connections, setConnections] = useState<ConnectionsData | null>(null);
  const refreshConnections = () => { void apiGet<ConnectionsData>("/api/connections").then(setConnections); };
  useEffect(() => { refreshConnections(); }, [state.connectionsEpoch]);
  const [, bump] = useState(0);
  const debugRef = useRef<{ byFloor: Record<number, any[]>; userCb: ((m: any) => void) | null; approvalCb: ((m: any) => void) | null }>({ byFloor: {}, userCb: null, approvalCb: null });

  // Decorative manual agents placed on desks (client-only, cleared on refresh).
  const [manuals, setManuals] = useState<ManualAgent[]>([]);
  const [manualEditor, setManualEditor] = useState<{ mode: "add"; zone: ZoneId; slot: number } | { mode: "edit"; agent: ManualAgent } | null>(null);
  useEffect(() => { try { localStorage.removeItem(MANUAL_KEY); } catch { /* private mode */ } }, []);
  useEffect(() => { try { localStorage.setItem(MANUAL_KEY, JSON.stringify(manuals)); } catch { /* quota/private */ } }, [manuals]);

  const activeId = state.selected != null && state.agents[state.selected] ? state.selected : state.order[0] ?? null;
  const model = sessionsModel(state, activeId, selFig, debugRef.current.byFloor, manuals);

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
  // Clicking a manual figure edits it; any other figure selects it as before.
  const onSelectFig = (id: string | null) => {
    if (id && id.startsWith("manual:")) { const m = manuals.find((x) => x.id === id); if (m) setManualEditor({ mode: "edit", agent: m }); return; }
    setSelFig(id);
  };
  const onDeskClick = (zone: ZoneId, slot: number) => setManualEditor({ mode: "add", zone, slot });

  const sendTo = (id: number, text: string) =>
    text.startsWith("/") ? send({ type: "command", tabId: id, command: text }) : send({ type: "input", tabId: id, text });

  // window.domOffice — debug overlay (add/update/think/remove/list/say/setFloor/addFloor).
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
      onUserMessage: (cb: any) => { debugRef.current.userCb = cb; },
      onApproval: (cb: any) => { debugRef.current.approvalCb = cb; },
    };
    (window as any).domOffice = api;
    return () => { if ((window as any).domOffice === api) delete (window as any).domOffice; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, activeId]);

  // Selected-figure detail for the popup.
  const figs = activeId != null ? floorFigures(state, activeId) : [];
  const selF = figs.find((f) => f.id === selFig) || null;
  const sel: SelDetail | null = selF
    ? { id: selF.id, name: selF.name, zone: zoneLabel(selF.zone), color: model.layout.colorById[selF.id] ?? "#C9C9D6", stateColor: STATE_COLOR[selF.state] ?? "#6B6B7B", state: selF.state, action: selF.action, output: selF.output, thinking: selF.thinking, awaiting: selF.state === "awaiting" }
    : null;

  // Auto-save to Obsidian: after a turn ends, if the vault is configured and the
  // response looks worth keeping (a code fence, a markdown table, or > 200 words),
  // save it automatically under a slug from the first line + today's date, and mark
  // that turn so the chat shows "auto-saved" instead of the SAVE TO VAULT button.
  const savedTurnsRef = useRef<Set<string>>(new Set());
  const [savedTurns, setSavedTurns] = useState<Record<string, boolean>>({});
  const endedEpoch = activeId != null ? (state.turnEpoch[activeId] ?? 0) - 1 : -1;
  useEffect(() => {
    if (activeId == null || !vault?.configured || endedEpoch < 0) return;
    const id = `${activeId}:${endedEpoch}`;
    if (savedTurnsRef.current.has(id)) return;
    savedTurnsRef.current.add(id);
    const lines = state.chatLines.filter((l) => l.tabId === activeId && l.epoch === endedEpoch);
    const text = lines.filter((l) => l.kind === "assistant" && l.text).map((l) => l.text!).join("\n").trim();
    if (!text) return;
    const hasCode = lines.some((l) => l.rule); // a ─── code fence in this turn
    const words = text.split(/\s+/).filter(Boolean).length;
    const hasTable = text.split("\n").filter((l) => /^\s*\|.*\|\s*$/.test(l)).length >= 2;
    if (!(hasCode || words > 200 || hasTable)) return;
    const first = (text.split("\n").find((l) => l.trim()) ?? "response").replace(/[`#*_>[\]-]/g, " ").trim();
    const slug = (first.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "response").toLowerCase();
    const date = new Date().toISOString().slice(0, 10);
    void saveVault(`${slug}-${date}`, ["auto-saved"], text).then((r) => { if (r.ok) setSavedTurns((p) => ({ ...p, [id]: true })); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, vault?.configured, endedEpoch]);

  // Chat = this floor's feed, grouped into per-speaker/per-turn message blocks
  // (line events + code fences + approval requests).
  const tabColor = (activeId != null ? model.layout.colorById[`tab:${activeId}`] : undefined) ?? "#6B6B7B";
  const rawLines = activeId != null ? state.chatLines.filter((l) => l.tabId === activeId) : [];
  const epochByKey: Record<string, number> = {};
  for (const l of rawLines) epochByKey[l.key] = l.epoch;
  const chat: ChatMsg[] = groupChat(rawLines)
    .slice(-40)
    .map((g) => {
      const pending = g.isApproval && !!state.permission && state.permission.id === g.permId && !g.resolved;
      const border = g.resolved ? (g.resolved === "no" ? "#F87171" : "#4ADE80") : g.isApproval ? "#FBBF24" : "#2A2A38";
      return {
        key: g.key, from: g.from, time: g.time, kind: g.kind, segments: g.segments,
        color: g.from === "YOU" ? "#C9C9D6" : tabColor,
        border,
        isApproval: pending,
        permId: g.permId,
        resolved: g.resolved,
        tool: g.tool,
        autoSaved: g.kind === "assistant" && !!savedTurns[`${activeId}:${epochByKey[g.key]}`],
      };
    });

  const answer = (a: string) => { if (state.permission) send({ type: "permission", id: state.permission.id, answer: a }); if (debugRef.current.approvalCb) debugRef.current.approvalCb({ approved: a !== "no" }); };
  const answerId = (permId: string | undefined, a: string) => { if (permId) send({ type: "permission", id: permId, answer: a }); };

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

  return (
    <TooltipProvider delayDuration={200}>
      <SessionsFloor
        model={model}
        chat={chat}
        sel={sel}
        draft={draft}
        steer={steer}
        commands={state.commands}
        activeTabId={activeId}
        requestFiles={requestFiles}
        onSelectFloor={(id) => { select(id); setSelFig(null); }}
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
        canSaveVault={!!vault?.configured}
        onSaveMsg={(content) => setSaveTarget(content)}
        leftPanel={<LeftPanel tabId={activeId} fileEpoch={state.fileEpoch} vault={vault} connections={connections} onAttach={attachFile} onRefreshVault={() => void apiGet<VaultTree>("/api/vault/tree").then(setVault)} onRefreshConnections={refreshConnections} onToggleMcp={(name, enabled) => send({ type: "mcp.toggle", name, enabled })} />}
        rightPanel={<BackgroundPanel jobEpoch={state.jobEpoch} send={send} />}
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
      <TerminalDock tabId={activeId} />
    </TooltipProvider>
  );
}

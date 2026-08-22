import { useEffect, useRef, useState } from "react";
import { useDomSocket } from "./store";
import { SessionsFloor, zoneLabel, type ChatMsg, type SelDetail } from "./SessionsFloor";
import { OverlayModal } from "./OverlayModal";
import { floorFigures, sessionsModel, STATE_COLOR } from "./sessions.js";

export function App() {
  const { state, send, select, requestFiles } = useDomSocket();
  const [selFig, setSelFig] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [steer, setSteer] = useState("");
  const [, bump] = useState(0);
  const debugRef = useRef<{ byFloor: Record<number, any[]>; userCb: ((m: any) => void) | null; approvalCb: ((m: any) => void) | null }>({ byFloor: {}, userCb: null, approvalCb: null });

  const activeId = state.selected != null && state.agents[state.selected] ? state.selected : state.order[0] ?? null;
  const model = sessionsModel(state, activeId, selFig, debugRef.current.byFloor);

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

  // Chat = this floor's feed (line events + approval requests).
  const chat: ChatMsg[] = state.officeFeed
    .filter((f) => f.tabId === activeId)
    .slice(-40)
    .map((f) => ({
      key: f.key, from: f.from, time: f.time, text: f.text,
      color: f.from === "YOU" ? "#C9C9D6" : model.layout.colorById[`tab:${f.tabId}`] ?? "#6B6B7B",
      border: f.kind === "approval" ? "#FBBF24" : "#2A2A38",
      isApproval: f.kind === "approval" && !!state.permission && state.permission.id === f.permId,
      permId: f.permId,
    }));

  const answer = (a: string) => { if (state.permission) send({ type: "permission", id: state.permission.id, answer: a }); if (debugRef.current.approvalCb) debugRef.current.approvalCb({ approved: a !== "no" }); };
  const answerId = (permId: string | undefined, a: string) => { if (permId) send({ type: "permission", id: permId, answer: a }); };

  const onSend = () => { const t = draft.trim(); if (!t || activeId == null) return; if (t.startsWith("/")) send({ type: "command", tabId: activeId, command: t }); else { send({ type: "input", tabId: activeId, text: t }); if (debugRef.current.userCb) debugRef.current.userCb({ text: t, floor: activeId }); } setDraft(""); };
  const onSteer = () => { const t = steer.trim(); if (t && selF) sendTo(selF.tabId, t); setSteer(""); };

  return (
    <>
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
        onSelectFig={setSelFig}
        onClose={() => setSelFig(null)}
        onApprove={() => answer("yes")}
        onDeny={() => answer("no")}
        onDismiss={() => { if (selF?.kind === "tab") send({ type: "agent.close", tabId: selF.tabId }); setSelFig(null); }}
        onSteer={onSteer}
        onSteerDraft={setSteer}
        onDraft={setDraft}
        onSend={onSend}
        onApproveMsg={(permId) => answerId(permId, "yes")}
        onDenyMsg={(permId) => answerId(permId, "no")}
      />
      {state.overlay && (
        <OverlayModal
          key={state.overlay.id}
          overlay={state.overlay}
          onSelect={(value) => send({ type: "overlay.select", id: state.overlay!.id, value })}
          onCancel={() => send({ type: "overlay.cancel", id: state.overlay!.id })}
        />
      )}
    </>
  );
}

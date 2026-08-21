import { useEffect, useRef, useState } from "react";
import { useDomSocket } from "./store";
import { OfficeFloor, type ChatMsg, type Mention } from "./OfficeFloor";
import { officeModel } from "./office.js";
import type { Agent, Preview, TranscriptItem } from "./types";

export function App() {
  const { state, send, select } = useDomSocket();
  const [view, setView] = useState<"chat" | "office">("chat");
  // Under 900px the office collapses to the sidebar+chat layout (it needs width).
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < 900);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const effectiveView = narrow ? "chat" : view;
  const selected = state.selected;
  const agent = selected != null ? state.agents[selected] : undefined;
  const items = selected != null ? state.transcripts[selected] ?? [] : [];
  const running = selected != null ? state.running[selected] : null;

  // Office-view local state (its own selection + drafts + chat target), plus a
  // debug overlay driven by window.domOffice.
  const [officeSel, setOfficeSel] = useState<number | string | null>(null);
  const [draft, setDraft] = useState("");
  const [steer, setSteer] = useState("");
  const [target, setTarget] = useState<{ label: string; id: number | null }>({ label: "PRIMARY", id: null });
  const [, bump] = useState(0);
  const debugRef = useRef<{ agents: any[]; feed: ChatMsg[]; userCb: ((m: any) => void) | null; approvalCb: ((m: any) => void) | null }>({ agents: [], feed: [], userCb: null, approvalCb: null });

  const sendTo = (id: number, text: string) =>
    text.startsWith("/") ? send({ type: "command", tabId: id, command: text }) : send({ type: "input", tabId: id, text });

  // window.domOffice — a debug overlay on top of the live-driven floor.
  useEffect(() => {
    const forceUpdate = () => bump((n) => n + 1);
    const api = {
      add: (a: any) => { const id = a?.id ?? `dbg-${debugRef.current.agents.length + 1}`; debugRef.current.agents.push({ ...a, id }); forceUpdate(); return id; },
      update: (id: any, patch: any) => { debugRef.current.agents = debugRef.current.agents.map((x) => (x.id === id ? { ...x, ...patch } : x)); forceUpdate(); },
      think: (id: any, line: string) => { debugRef.current.agents = debugRef.current.agents.map((x) => (x.id === id ? { ...x, thinking: (x.thinking || []).concat([line]) } : x)); forceUpdate(); },
      remove: (id: any) => { debugRef.current.agents = debugRef.current.agents.filter((x) => x.id !== id); forceUpdate(); },
      list: () => officeModel(state, debugRef.current.agents).placed.map((a) => ({ ...a })),
      say: (m: any) => { debugRef.current.feed.push({ key: `dbg${Date.now()}`, from: m.from || "SYSTEM", color: m.color || "#6B6B7B", text: m.text || "", time: m.time || "", border: m.kind === "approval" ? "#FBBF24" : "#2A2A38" }); debugRef.current.feed = debugRef.current.feed.slice(-40); forceUpdate(); },
      onUserMessage: (cb: any) => { debugRef.current.userCb = cb; },
      onApproval: (cb: any) => { debugRef.current.approvalCb = cb; },
      zones: ["coordinator", "planning", "coding", "application", "subagents"],
    };
    (window as any).domOffice = api;
    return () => { if ((window as any).domOffice === api) delete (window as any).domOffice; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const model = officeModel(state, debugRef.current.agents);
  const colorByTab: Record<number, string> = {};
  for (const a of [...model.placed, ...model.offFloor]) if (typeof a.id === "number") colorByTab[a.id] = a.color;

  const chat: ChatMsg[] = [
    ...state.officeFeed.map((f) => ({ key: f.key, from: f.from, color: f.from === "YOU" ? "#C9C9D6" : colorByTab[f.tabId] ?? "#6B6B7B", text: f.text, time: f.time, border: f.kind === "approval" ? "#FBBF24" : "#2A2A38" })),
    ...debugRef.current.feed,
  ].slice(-40);

  const primaryId = state.order[0] ?? null;
  const targetId = target.id ?? primaryId;
  const mentions: Mention[] = [
    { key: "all", label: "@ALL", color: target.id == null ? "#C9C9D6" : "#6B6B7B", border: target.id == null ? "#6B6B7B" : "#2A2A38", onClick: () => setTarget({ label: "PRIMARY", id: null }) },
    ...model.placed.filter((a) => typeof a.id === "number").slice(0, 3).map((a) => ({
      key: String(a.id), label: `@${a.name}`.toUpperCase().slice(0, 8), color: target.id === a.id ? a.color : "#6B6B7B", border: target.id === a.id ? a.color : "#2A2A38",
      onClick: () => setTarget({ label: a.name, id: a.id as number }),
    })),
  ];

  const officeSend = () => {
    const text = draft.trim();
    if (!text) return;
    if (targetId != null) sendTo(targetId, text);
    if (debugRef.current.userCb) debugRef.current.userCb({ text, target: target.label });
    setDraft("");
  };
  const officeSteer = () => {
    const text = steer.trim();
    if (text && typeof officeSel === "number") sendTo(officeSel, text);
    setSteer("");
  };
  const answerPermission = (answer: string) => {
    if (state.permission) send({ type: "permission", id: state.permission.id, answer });
    if (debugRef.current.approvalCb) debugRef.current.approvalCb({ id: officeSel, approved: answer !== "no", action: "" });
  };

  return (
    <div className="app">
      <Sidebar
        order={state.order}
        agents={state.agents}
        selected={selected}
        connected={state.connected}
        view={effectiveView}
        narrow={narrow}
        onView={setView}
        onSelect={select}
        onCreate={() => send({ type: "agent.create" })}
      />
      <main className="main">
        {effectiveView === "office" ? (
          <div className="office-wrap">
            <OfficeFloor
              model={model}
              selectedId={officeSel}
              chat={chat}
              draft={draft}
              steer={steer}
              chatTarget={target.label}
              ctxLine={`${state.order.length} tabs · ${model.awaiting} awaiting`}
              mentions={mentions}
              onSelect={setOfficeSel}
              onClose={() => setOfficeSel(null)}
              onSteer={officeSteer}
              onSteerDraft={setSteer}
              onApprove={() => answerPermission("yes")}
              onDeny={() => answerPermission("no")}
              onToggleIdle={() => {}}
              onDismiss={() => { if (typeof officeSel === "number") send({ type: "agent.close", tabId: officeSel }); setOfficeSel(null); }}
              onDraft={setDraft}
              onSend={officeSend}
              onSpawn={() => send({ type: "agent.create" })}
            />
          </div>
        ) : agent ? (
          <>
            <Transcript items={items} running={running} />
            <Composer disabled={!state.connected} onSend={(text) => sendTo(agent.id, text)} />
            <StatusBar agent={agent} />
          </>
        ) : (
          <div className="empty">{state.connected ? "no agents — create one" : "connecting…"}</div>
        )}
      </main>

      {state.permission && (
        <PermissionModal
          preview={state.permission.preview}
          options={state.permission.options}
          agentName={state.agents[state.permission.tabId]?.name}
          onAnswer={(answer) => send({ type: "permission", id: state.permission!.id, answer })}
        />
      )}
    </div>
  );
}

function Sidebar(props: {
  order: number[];
  agents: Record<number, Agent>;
  selected: number | null;
  connected: boolean;
  view: "chat" | "office";
  narrow: boolean;
  onView: (v: "chat" | "office") => void;
  onSelect: (id: number) => void;
  onCreate: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        dom <span className={props.connected ? "dot on" : "dot off"} title={props.connected ? "connected" : "disconnected"} />
      </div>
      <div className="viewtabs">
        <button className={props.view === "chat" ? "on" : ""} onClick={() => props.onView("chat")}>
          chat
        </button>
        <button
          className={props.view === "office" ? "on" : ""}
          disabled={props.narrow}
          title={props.narrow ? "widen the window for the office view" : ""}
          onClick={() => props.onView("office")}
        >
          office
        </button>
      </div>
      <div className="agents">
        {props.order.map((id) => {
          const a = props.agents[id]!;
          return (
            <button key={id} className={`agent ${id === props.selected ? "active" : ""}`} onClick={() => props.onSelect(id)}>
              <span className="agent-name">{a.name}</span>
              <span className={`badge mode-${a.mode}`}>{a.mode}</span>
              <span className="agent-model">{shortModel(a.model)}</span>
              {a.busy && <span className="spinner" title="busy" />}
            </button>
          );
        })}
      </div>
      <button className="new-agent" onClick={props.onCreate}>
        + new agent
      </button>
    </aside>
  );
}

function Transcript(props: { items: TranscriptItem[]; running: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.items.length, props.running]);

  return (
    <div className="transcript" ref={ref}>
      {props.items.map((it, i) => (
        <Row key={i} item={it} />
      ))}
      {props.running && (
        <div className="row tool running">
          <span className="tool-sig">
            <span className="dot-run" /> {props.running}…
          </span>
        </div>
      )}
    </div>
  );
}

function Row({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="row user">
          <span className="chevron">❯</span> {item.text}
        </div>
      );
    case "rule":
      return <div className="row rule">{item.lang ? `── ${item.lang}` : "──"}</div>;
    case "system":
      return <div className="row system">{item.text}</div>;
    case "tool":
      return (
        <div className={`row tool ${item.ok ? "ok" : "err"}`}>
          <div className="tool-sig">
            <span className={item.ok ? "dot-ok" : "dot-err"} /> {item.tool}
            <span className="tool-arg">({item.primary}{item.secondary})</span>
          </div>
          {item.summary && <div className="tool-summary">⎿ {item.summary}</div>}
        </div>
      );
    default:
      return <div className="row line">{item.text}</div>;
  }
}

function Composer(props: { disabled: boolean; onSend: (text: string) => void }) {
  const [value, setValue] = useState("");
  const submit = () => {
    const t = value.trim();
    if (!t) return;
    props.onSend(t);
    setValue("");
  };
  return (
    <div className="composer">
      <input
        value={value}
        placeholder={props.disabled ? "disconnected…" : "message, or /command"}
        disabled={props.disabled}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button onClick={submit} disabled={props.disabled}>
        send
      </button>
    </div>
  );
}

function StatusBar({ agent }: { agent: Agent }) {
  return (
    <div className="statusbar">
      <span className="cwd" title={agent.cwd}>
        {agent.cwd}
      </span>
      <span className="sep">·</span>
      <span>{shortModel(agent.model)}</span>
      <span className="sep">·</span>
      <span className={`badge mode-${agent.mode}`}>{agent.mode}</span>
      <span className="sep">·</span>
      <span>${agent.cost.toFixed(4)}</span>
      <span className="sep">·</span>
      <span>{agent.tokens.toLocaleString()} tok</span>
      {agent.busy && <span className="working">working…</span>}
    </div>
  );
}

function PermissionModal(props: { preview: Preview; options: string[]; agentName?: string; onAnswer: (a: string) => void }) {
  const p = props.preview;
  return (
    <div className="modal-backdrop">
      <div className={`modal ${p.dangerous ? "danger" : ""}`}>
        <div className="modal-head">
          approval needed{props.agentName ? ` · ${props.agentName}` : ""}
          {p.dangerous && <span className="warn-tag">⚠ dangerous</span>}
        </div>
        <PreviewBody preview={p} />
        {"warning" in p && p.warning && <div className="warn">⚠ {p.warning}</div>}
        <div className="modal-actions">
          {props.options.map((opt) => (
            <button key={opt} className={`answer ${opt}`} onClick={() => props.onAnswer(opt)}>
              {opt}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function PreviewBody({ preview }: { preview: Preview }) {
  if (preview.kind === "bash") {
    return (
      <div className="preview">
        <pre className="cmd">$ {preview.command}</pre>
        <div className="dim">in {preview.cwd}</div>
      </div>
    );
  }
  if (preview.kind === "http") {
    return (
      <div className="preview">
        <pre className="cmd">
          {preview.method} {preview.url}
        </pre>
      </div>
    );
  }
  return (
    <div className="preview">
      <div className="dim">
        {preview.tool} {preview.absPath}
      </div>
      <pre className="diff">
        {preview.lines.map((l, i) => (
          <div key={i} className={`dl ${l.kind}`}>
            {l.text}
          </div>
        ))}
        {preview.moreLines > 0 && <div className="dl ctx">(+{preview.moreLines} more lines)</div>}
      </pre>
    </div>
  );
}

function shortModel(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

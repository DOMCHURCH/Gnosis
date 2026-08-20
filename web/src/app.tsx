import { useEffect, useRef, useState } from "react";
import { useDomSocket } from "./store";
import { Building } from "./Building";
import { buildingInput, deriveBuilding } from "./floors.js";
import type { Agent, Preview, TranscriptItem } from "./types";

export function App() {
  const { state, send, select } = useDomSocket();
  const [view, setView] = useState<"chat" | "building">("chat");
  const [miniId, setMiniId] = useState<number | null>(null);
  // Under 900px the building collapses to the sidebar+chat layout (it needs width).
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

  const sendTo = (id: number, text: string) =>
    text.startsWith("/") ? send({ type: "command", tabId: id, command: text }) : send({ type: "input", tabId: id, text });

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
        {effectiveView === "building" ? (
          <div className="building-wrap">
            {state.order.length ? (
              <Building model={deriveBuilding(buildingInput(state))} onPick={(id) => setMiniId(id)} />
            ) : (
              <div className="empty">{state.connected ? "no agents yet" : "connecting…"}</div>
            )}
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

      {effectiveView === "building" && miniId != null && state.agents[miniId] && (
        <MiniChat
          agent={state.agents[miniId]!}
          items={state.transcripts[miniId] ?? []}
          onClose={() => setMiniId(null)}
          onSend={(text) => sendTo(miniId, text)}
        />
      )}

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

function MiniChat(props: { agent: Agent; items: TranscriptItem[]; onClose: () => void; onSend: (text: string) => void }) {
  const recent = props.items.slice(-40);
  return (
    <div className="minichat">
      <div className="minichat-head">
        <span>{props.agent.name}</span>
        <span className={`badge mode-${props.agent.mode}`}>{props.agent.mode}</span>
        {props.agent.busy && <span className="spinner" />}
        <button className="mini-close" onClick={props.onClose}>
          ✕
        </button>
      </div>
      <Transcript items={recent} running={null} />
      <Composer disabled={false} onSend={props.onSend} />
    </div>
  );
}

function Sidebar(props: {
  order: number[];
  agents: Record<number, Agent>;
  selected: number | null;
  connected: boolean;
  view: "chat" | "building";
  narrow: boolean;
  onView: (v: "chat" | "building") => void;
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
          className={props.view === "building" ? "on" : ""}
          disabled={props.narrow}
          title={props.narrow ? "widen the window for the building view" : ""}
          onClick={() => props.onView("building")}
        >
          building
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

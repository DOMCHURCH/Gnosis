import { useCallback, useEffect, useReducer, useRef } from "react";
import type { Agent, ClientMessage, DomEvent, MessageLink, OverlayState, PermissionRequest, SubAgent, TranscriptItem } from "./types";
import { resolveApproval } from "./chatgroups.js";

export interface State {
  connected: boolean;
  agents: Record<number, Agent>;
  order: number[];
  transcripts: Record<number, TranscriptItem[]>;
  /** Currently-running tool label per agent (from tool.start), cleared on end. */
  running: Record<number, string | null>;
  /** Running background jobs per agent (job.start/end) — id + command for the figure. */
  jobs: Record<number, { id: string; command: string }[]>;
  /** Live sub-agents (subagent.start/end) — figures on the Sub-agents floor. */
  subagents: SubAgent[];
  /** Transient tab-to-tab message links (message.sent), cleared after a moment. */
  links: MessageLink[];
  /** Current activity label per agent — the office figure's `action`. */
  actions: Record<number, string>;
  /** Transient 'just spoke' flag per agent (set on turn.end, cleared after a beat). */
  speaking: Record<number, boolean>;
  /** Raw per-tab chat lines (text, code-fence markers, approvals) with the turn
   * epoch they belong to. The renderer groups consecutive same-speaker/same-turn
   * lines into one message block (see chatgroups.js). */
  chatLines: RawLine[];
  /** Monotonic turn counter per tab; bumped on turn.end so a new turn's lines can't
   * merge into the previous turn's message block. */
  turnEpoch: Record<number, number>;
  /** Whether the current line stream for a tab is inside a ``` code fence. */
  inCode: Record<number, boolean>;
  /** Slash-command registry, sent by the server on connect (same as the TUI). */
  commands: CommandItem[];
  selected: number | null;
  permission: PermissionRequest | null;
  /** Live selection overlay mirrored from the TUI (/model, /resume, @, Ctrl+R). */
  overlay: OverlayState | null;
}

/** One raw chat line before grouping. `rule` marks a code-fence boundary; `text`
 * is a prose/approval line. `kind`: user | assistant | system | approval | tool. */
export interface RawLine {
  key: string; tabId: number; from: string; kind: string; epoch: number; time: string;
  text?: string; rule?: "open" | "close"; lang?: string;
  // approval (kind "approval"): the previewed action, and the answer once resolved.
  permId?: string; label?: string; resolved?: string;
  // tool call (kind "tool"): the compact call parts + summary, and the full detail.
  tool?: string; primary?: string; secondary?: string; ok?: boolean; summary?: string; detail?: string;
}
export interface CommandItem { name: string; args?: string; desc: string; }

function previewLabel(p: unknown): string {
  const q = p as { kind?: string; command?: string; method?: string; url?: string; tool?: string; path?: string };
  if (!q) return "";
  if (q.kind === "bash") return q.command ?? "";
  if (q.kind === "http") return `${q.method} ${q.url}`;
  if (q.kind === "diff") return `${q.tool} ${q.path}`;
  return "";
}

const initial: State = { connected: false, agents: {}, order: [], transcripts: {}, running: {}, jobs: {}, subagents: [], links: [], actions: {}, speaking: {}, chatLines: [], turnEpoch: {}, inCode: {}, commands: [], selected: null, permission: null, overlay: null };

/** Append a raw chat line, capping the buffer so the feed can't grow unbounded. */
function pushLine(state: State, ln: RawLine): State {
  const chatLines = [...state.chatLines, ln];
  return { ...state, chatLines: chatLines.length > 500 ? chatLines.slice(-500) : chatLines };
}

type Action = DomEvent | { type: "@connected"; value: boolean } | { type: "@select"; id: number } | { type: "@clearLink"; key: string } | { type: "@clearSpeaking"; tabId: number } | { type: "@commands"; list: CommandItem[] };

function clock(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function argLabel(args: unknown): string {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    const v = a.path ?? a.pattern ?? a.command ?? a.query ?? a.url;
    if (typeof v === "string") return v.length > 24 ? v.slice(0, 23) + "…" : v;
  }
  return "";
}

function idByName(state: State, name: string): number | null {
  for (const id of state.order) if (state.agents[id]?.name === name) return id;
  return null;
}

function withItem(state: State, tabId: number, item: TranscriptItem): State {
  const cur = state.transcripts[tabId] ?? [];
  return { ...state, transcripts: { ...state.transcripts, [tabId]: [...cur, item] } };
}
function patchAgent(state: State, tabId: number, fn: (a: Agent) => Agent): State {
  const a = state.agents[tabId];
  if (!a) return state;
  return { ...state, agents: { ...state.agents, [tabId]: fn(a) } };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "@connected":
      return { ...state, connected: action.value };
    case "@select":
      return { ...state, selected: action.id };
    case "agent.created": {
      if (state.agents[action.tabId]) return state; // snapshot may duplicate
      const agent: Agent = { id: action.tabId, name: action.name, cwd: action.cwd, model: action.model, mode: action.mode, busy: false, cost: 0, tokens: 0, awaitingPermission: false };
      return {
        ...state,
        agents: { ...state.agents, [action.tabId]: agent },
        order: [...state.order, action.tabId],
        transcripts: { ...state.transcripts, [action.tabId]: state.transcripts[action.tabId] ?? [] },
        selected: state.selected ?? action.tabId,
      };
    }
    case "agent.closed": {
      const agents = { ...state.agents };
      delete agents[action.tabId];
      const order = state.order.filter((id) => id !== action.tabId);
      return { ...state, agents, order, selected: state.selected === action.tabId ? order[0] ?? null : state.selected };
    }
    case "agent.mode":
      return patchAgent(state, action.tabId, (a) => ({ ...a, mode: action.mode }));
    case "agent.busy":
      return patchAgent(state, action.tabId, (a) => ({ ...a, busy: action.busy }));
    case "turn.end": {
      // A turn just finished → the agent 'spoke' for a beat (drives the speaking
      // cue). The activity line is derived from live state (activityFor), never the
      // last sentence, so we no longer stash message text as the action.
      const withCost = patchAgent(state, action.tabId, (a) => ({ ...a, cost: a.cost + action.cost, tokens: a.tokens + action.tokens }));
      return {
        ...withCost,
        speaking: { ...withCost.speaking, [action.tabId]: true },
        // A finished turn ends the current message block and closes any open fence.
        turnEpoch: { ...withCost.turnEpoch, [action.tabId]: (withCost.turnEpoch[action.tabId] ?? 0) + 1 },
        inCode: { ...withCost.inCode, [action.tabId]: false },
      };
    }
    case "@clearSpeaking":
      return { ...state, speaking: { ...state.speaking, [action.tabId]: false } };
    case "@commands":
      return { ...state, commands: action.list };
    case "line": {
      // Drop the per-turn cost line ("· turn: 5930 in · 45 out · $0.0005") — the
      // header carries session totals; it must not clutter the chat or the roster.
      if (action.item.kind === "system" && "text" in action.item && /turn:.*\bin\b.*\bout\b.*\$/.test(action.item.text)) return state;
      const next = withItem(state, action.tabId, action.item);
      const epoch = state.turnEpoch[action.tabId] ?? 0;
      const from = action.item.kind === "user" ? "YOU" : state.agents[action.tabId]?.name ?? `#${action.tabId}`;
      const seq = next.chatLines.length;
      // A ``` fence toggles code mode for this tab; the grouper renders the enclosed
      // lines as a monospace block (mirrors the TUI's ─── rule boundary).
      if (action.item.kind === "rule") {
        const opening = !state.inCode[action.tabId];
        const lang = "lang" in action.item ? action.item.lang ?? "" : "";
        const ln: RawLine = { key: `r${action.tabId}-${seq}-${Date.now()}`, tabId: action.tabId, from, kind: "assistant", epoch, time: clock(), rule: opening ? "open" : "close", lang: opening ? lang : "" };
        return pushLine({ ...next, inCode: { ...next.inCode, [action.tabId]: opening } }, ln);
      }
      if ("text" in action.item && action.item.text) {
        const kind = action.item.kind === "user" ? "user" : action.item.kind === "system" ? "system" : "assistant";
        const ln: RawLine = { key: `f${action.tabId}-${seq}-${Date.now()}`, tabId: action.tabId, from, kind, epoch, time: clock(), text: action.item.text };
        return pushLine(next, ln);
      }
      return next;
    }
    case "tool.start":
      return {
        ...state,
        running: { ...state.running, [action.tabId]: action.tool },
        actions: { ...state.actions, [action.tabId]: `${action.tool}${argLabel(action.args) ? " " + argLabel(action.args) : ""}` },
      };
    case "tool.end": {
      const withTx = withItem({ ...state, running: { ...state.running, [action.tabId]: null } }, action.tabId, {
        kind: "tool",
        tool: action.tool,
        primary: action.primary,
        secondary: action.secondary,
        ok: action.ok,
        summary: action.summary,
      });
      // Also render the call in the chat rail (compact line, expandable to detail).
      const epoch = state.turnEpoch[action.tabId] ?? 0;
      const from = state.agents[action.tabId]?.name ?? `#${action.tabId}`;
      const ln: RawLine = { key: `t${action.tabId}-${withTx.chatLines.length}-${Date.now()}`, tabId: action.tabId, from, kind: "tool", epoch, time: clock(), tool: action.tool, primary: action.primary, secondary: action.secondary, ok: action.ok, summary: action.summary, detail: action.detail };
      return pushLine(withTx, ln);
    }
    case "subagent.start":
      return withItem(
        { ...state, subagents: [...state.subagents, { parentId: action.tabId, description: action.description, key: `${action.tabId}:${action.description}:${state.subagents.length}` }] },
        action.tabId,
        { kind: "system", text: `⟳ sub-agent: ${action.description}` },
      );
    case "subagent.end": {
      const i = state.subagents.findIndex((s) => s.parentId === action.tabId && s.description === action.description);
      const subagents = i >= 0 ? state.subagents.filter((_, k) => k !== i) : state.subagents;
      return withItem({ ...state, subagents }, action.tabId, { kind: "system", text: `✓ sub-agent done: ${action.description}` });
    }
    case "job.start": {
      const tid = action.tabId ?? state.selected;
      const jobs = action.tabId != null ? { ...state.jobs, [action.tabId]: [...(state.jobs[action.tabId] ?? []), { id: action.jobId, command: action.command }] } : state.jobs;
      const next = { ...state, jobs };
      return tid == null ? next : withItem(next, tid, { kind: "system", text: `⎈ job ${action.jobId}: ${action.command}` });
    }
    case "job.end": {
      const tid = action.tabId ?? state.selected;
      const jobs = action.tabId != null ? { ...state.jobs, [action.tabId]: (state.jobs[action.tabId] ?? []).filter((j) => j.id !== action.jobId) } : state.jobs;
      const next = { ...state, jobs };
      return tid == null ? next : withItem(next, tid, { kind: "system", text: `⎈ job ${action.jobId} ${action.status}` });
    }
    case "message.sent": {
      const from = idByName(state, action.from);
      const to = idByName(state, action.to);
      if (from == null || to == null) return state;
      return { ...state, links: [...state.links, { from, to, key: `${action.from}->${action.to}` }] };
    }
    case "@clearLink":
      return { ...state, links: state.links.filter((l) => l.key !== action.key) };
    case "permission.request": {
      const withFlag = patchAgent(state, action.tabId, (a) => ({ ...a, awaitingPermission: true }));
      const from = state.agents[action.tabId]?.name ?? `#${action.tabId}`;
      const epoch = state.turnEpoch[action.tabId] ?? 0;
      const label = previewLabel(action.preview);
      const ln: RawLine = { key: `p${action.id}`, tabId: action.tabId, from, kind: "approval", epoch, time: clock(), text: `Needs approval: ${label}`, permId: action.id, label };
      return { ...pushLine(withFlag, ln), permission: { tabId: action.tabId, id: action.id, preview: action.preview, options: action.options } };
    }
    case "permission.resolved": {
      const cleared = patchAgent(state, action.tabId, (a) => ({ ...a, awaitingPermission: false }));
      // Replace the pending amber card with the outcome, in resolved styling —
      // whichever client answered first, the card here updates.
      const next = { ...cleared, chatLines: resolveApproval(cleared.chatLines, action.id, action.answer) };
      return next.permission?.id === action.id ? { ...next, permission: null } : next;
    }
    case "overlay.open":
      return { ...state, overlay: { id: action.id, tabId: action.tabId, kind: action.kind, title: action.title, items: action.items, selected: action.selected } };
    case "overlay.resolved":
      return state.overlay?.id === action.id ? { ...state, overlay: null } : state;
    default:
      return state; // turn.start
  }
}

export function useDomSocket() {
  const [state, dispatch] = useReducer(reducer, initial);
  const wsRef = useRef<WebSocket | null>(null);
  // Highest server seq seen; sent as ?since on reconnect to replay missed events.
  const lastSeqRef = useRef<number | null>(null);
  // Pending @-file requests keyed by reqId (resolved when the server replies).
  const filesRef = useRef<{ seq: number; pending: Map<number, (list: string[]) => void> }>({ seq: 0, pending: new Map() });

  useEffect(() => {
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const token = new URLSearchParams(location.search).get("token") ?? "";
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const since = lastSeqRef.current != null ? `&since=${lastSeqRef.current}` : "";
      const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}${since}`);
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        dispatch({ type: "@connected", value: true });
      };
      ws.onclose = () => {
        dispatch({ type: "@connected", value: false });
        if (closed) return;
        retry = Math.min(retry + 1, 6);
        timer = setTimeout(connect, Math.min(200 * 2 ** retry, 5000)); // capped backoff
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      };
      ws.onmessage = (e) => {
        let ev: (Action | { type: "@sync" }) & { seq?: number };
        try {
          ev = JSON.parse(e.data);
        } catch {
          return; // ignore malformed frame
        }
        if (typeof ev.seq === "number") lastSeqRef.current = ev.seq;
        if (ev.type === "@sync") return; // control frame: only advances lastSeq
        if ((ev as any).type === "commands") { dispatch({ type: "@commands", list: (ev as any).list ?? [] }); return; }
        if ((ev as any).type === "files") { const r = filesRef.current.pending.get((ev as any).reqId); if (r) { filesRef.current.pending.delete((ev as any).reqId); r((ev as any).list ?? []); } return; }
        dispatch(ev);
        // A tab-to-tab message draws a link; fade it after a moment.
        if (ev.type === "message.sent") {
          const key = `${ev.from}->${ev.to}`;
          setTimeout(() => dispatch({ type: "@clearLink", key }), 1600);
        }
        // 'speaking' is a brief post-turn state; clear it after a beat.
        if (ev.type === "turn.end") {
          const tabId = ev.tabId;
          setTimeout(() => dispatch({ type: "@clearSpeaking", tabId }), 2500);
        }
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const select = useCallback((id: number) => dispatch({ type: "@select", id }), []);

  // @-autocomplete: ask the server for ranked files under the tab's cwd.
  const requestFiles = useCallback((tabId: number, query: string): Promise<string[]> => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve([]);
    const reqId = ++filesRef.current.seq;
    return new Promise<string[]>((resolve) => {
      filesRef.current.pending.set(reqId, resolve);
      setTimeout(() => { if (filesRef.current.pending.delete(reqId)) resolve([]); }, 2000);
      ws.send(JSON.stringify({ type: "files", tabId, query, reqId }));
    });
  }, []);

  return { state, send, select, requestFiles };
}

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { Agent, ClientMessage, DomEvent, MessageLink, PermissionRequest, SubAgent, TranscriptItem } from "./types";

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
  /** Rolling floor-wide chat feed for the office view (from line events). */
  officeFeed: FeedItem[];
  selected: number | null;
  permission: PermissionRequest | null;
}

export interface FeedItem { key: string; tabId: number; from: string; text: string; kind: string; time: string; permId?: string; }

function previewLabel(p: unknown): string {
  const q = p as { kind?: string; command?: string; method?: string; url?: string; tool?: string; path?: string };
  if (!q) return "";
  if (q.kind === "bash") return q.command ?? "";
  if (q.kind === "http") return `${q.method} ${q.url}`;
  if (q.kind === "diff") return `${q.tool} ${q.path}`;
  return "";
}

const initial: State = { connected: false, agents: {}, order: [], transcripts: {}, running: {}, jobs: {}, subagents: [], links: [], actions: {}, speaking: {}, officeFeed: [], selected: null, permission: null };

type Action = DomEvent | { type: "@connected"; value: boolean } | { type: "@select"; id: number } | { type: "@clearLink"; key: string } | { type: "@clearSpeaking"; tabId: number };

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
      // A turn just finished → the agent 'spoke' for a beat; its action becomes the
      // last thing it said (or the last tool result).
      const items = state.transcripts[action.tabId] ?? [];
      const last = [...items].reverse().find((it) => (it.kind === "line" || it.kind === "system") && !!it.text);
      const said = last && "text" in last ? last.text.slice(0, 60) : undefined;
      const withCost = patchAgent(state, action.tabId, (a) => ({ ...a, cost: a.cost + action.cost, tokens: a.tokens + action.tokens }));
      return {
        ...withCost,
        speaking: { ...withCost.speaking, [action.tabId]: true },
        actions: said ? { ...withCost.actions, [action.tabId]: said } : withCost.actions,
      };
    }
    case "@clearSpeaking":
      return { ...state, speaking: { ...state.speaking, [action.tabId]: false } };
    case "line": {
      const next = withItem(state, action.tabId, action.item);
      // Feed text lines (not rules) into the office chat rail.
      if (action.item.kind !== "rule" && "text" in action.item && action.item.text) {
        const from = action.item.kind === "user" ? "YOU" : state.agents[action.tabId]?.name ?? `#${action.tabId}`;
        const feed = [...next.officeFeed, { key: `f${action.tabId}-${next.officeFeed.length}-${Date.now()}`, tabId: action.tabId, from, text: action.item.text, kind: action.item.kind, time: clock() }];
        return { ...next, officeFeed: feed.slice(-40) };
      }
      return next;
    }
    case "tool.start":
      return {
        ...state,
        running: { ...state.running, [action.tabId]: action.tool },
        actions: { ...state.actions, [action.tabId]: `${action.tool}${argLabel(action.args) ? " " + argLabel(action.args) : ""}` },
      };
    case "tool.end":
      return withItem({ ...state, running: { ...state.running, [action.tabId]: null } }, action.tabId, {
        kind: "tool",
        tool: action.tool,
        primary: action.primary,
        secondary: action.secondary,
        ok: action.ok,
        summary: action.summary,
      });
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
      const feed = [...withFlag.officeFeed, { key: `p${action.id}`, tabId: action.tabId, from, text: `Needs approval: ${previewLabel(action.preview)}`, kind: "approval", time: clock(), permId: action.id }];
      return { ...withFlag, officeFeed: feed.slice(-60), permission: { tabId: action.tabId, id: action.id, preview: action.preview, options: action.options } };
    }
    case "permission.resolved": {
      const cleared = patchAgent(state, action.tabId, (a) => ({ ...a, awaitingPermission: false }));
      return cleared.permission?.id === action.id ? { ...cleared, permission: null } : cleared;
    }
    default:
      return state; // turn.start
  }
}

export function useDomSocket() {
  const [state, dispatch] = useReducer(reducer, initial);
  const wsRef = useRef<WebSocket | null>(null);
  // Highest server seq seen; sent as ?since on reconnect to replay missed events.
  const lastSeqRef = useRef<number | null>(null);

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

  return { state, send, select };
}

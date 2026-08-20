import { useCallback, useEffect, useReducer, useRef } from "react";
import type { Agent, ClientMessage, DomEvent, PermissionRequest, TranscriptItem } from "./types";

export interface State {
  connected: boolean;
  agents: Record<number, Agent>;
  order: number[];
  transcripts: Record<number, TranscriptItem[]>;
  /** Currently-running tool label per agent (from tool.start), cleared on end. */
  running: Record<number, string | null>;
  selected: number | null;
  permission: PermissionRequest | null;
}

const initial: State = { connected: false, agents: {}, order: [], transcripts: {}, running: {}, selected: null, permission: null };

type Action = DomEvent | { type: "@connected"; value: boolean } | { type: "@select"; id: number };

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
      const agent: Agent = { id: action.tabId, name: action.name, cwd: action.cwd, model: action.model, mode: action.mode, busy: false, cost: 0, tokens: 0 };
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
    case "turn.end":
      return patchAgent(state, action.tabId, (a) => ({ ...a, cost: a.cost + action.cost, tokens: a.tokens + action.tokens }));
    case "line":
      return withItem(state, action.tabId, action.item);
    case "tool.start":
      return { ...state, running: { ...state.running, [action.tabId]: action.tool } };
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
      return withItem(state, action.tabId, { kind: "system", text: `⟳ sub-agent: ${action.description}` });
    case "subagent.end":
      return withItem(state, action.tabId, { kind: "system", text: `✓ sub-agent done: ${action.description}` });
    case "job.start": {
      const tid = action.tabId ?? state.selected;
      return tid == null ? state : withItem(state, tid, { kind: "system", text: `⎈ job ${action.jobId}: ${action.command}` });
    }
    case "job.end": {
      const tid = action.tabId ?? state.selected;
      return tid == null ? state : withItem(state, tid, { kind: "system", text: `⎈ job ${action.jobId} ${action.status}` });
    }
    case "permission.request":
      return { ...state, permission: { tabId: action.tabId, id: action.id, preview: action.preview, options: action.options } };
    case "permission.resolved":
      return state.permission?.id === action.id ? { ...state, permission: null } : state;
    default:
      return state; // turn.start, message.sent (used by the phase-3 building)
  }
}

export function useDomSocket() {
  const [state, dispatch] = useReducer(reducer, initial);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const token = new URLSearchParams(location.search).get("token") ?? "";
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
    wsRef.current = ws;
    ws.onopen = () => dispatch({ type: "@connected", value: true });
    ws.onclose = () => dispatch({ type: "@connected", value: false });
    ws.onmessage = (e) => {
      try {
        dispatch(JSON.parse(e.data) as Action);
      } catch {
        /* ignore malformed frame */
      }
    };
    return () => ws.close();
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const select = useCallback((id: number) => dispatch({ type: "@select", id }), []);

  return { state, send, select };
}

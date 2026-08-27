import { useCallback, useEffect, useReducer, useRef } from "react";
import type { Agent, ClientMessage, DomEvent, GoalReview, GoalState, MessageLink, OverlayState, PermissionRequest, SubAgent, TranscriptItem } from "./types";
import { resolveApproval } from "./chatgroups.js";
import { foldTelemetry } from "./telemetry.js";
import { pushOfficeRequest } from "./sessions.js";
import type { Telemetry } from "./telemetry";
import { planFromEvent, foldPlan } from "./taskplan.js";
import { tokenRejected } from "./api";
import type { TaskPlan } from "./taskplan";


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
  /** Bumped on every tool.end so the File Browser re-reads the tree after a write/
   * edit/bash may have changed files on disk (reuses the existing event stream). */
  fileEpoch: number;
  /** Bumped on every job.start/job.end so the Background panel re-reads /api/jobs
   * (pid/port/status come from that snapshot, not the lean lifecycle events). */
  jobEpoch: number;
  /** Bumped on tool.end and on vault.changed so the Obsidian panel re-reads the
   * vault note tree after dom (or a "save to vault") writes a note. */
  vaultEpoch: number;
  /** Bumped on connections.changed and job start/end so the CONNECTIONS tab
   * re-reads /api/connections (MCP status, HTTP jobs). */
  connectionsEpoch: number;
  /** The goal bar's standing goal per tab (goal.state), null when cleared. */
  goals: Record<number, GoalState | null>;
  /** The latest goal review per tab (goal.review) — verdict shown above the rail. */
  reviews: Record<number, GoalReview>;
  /** Per-tab telemetry (tool counts, tokens, turns, elapsed) folded from the event
   * stream — drives the agent telemetry panel. */
  telemetry: Record<number, Telemetry>;
  /** The active/last coordinated-task plan per tab (task.plan + subagent.start/end),
   * null when the tab has never run one. Drives the task execution plan view. */
  plans: Record<number, TaskPlan | null>;
  /** Latest design-mode before/after screenshot pair per tab (design.shot). */
  designShots: Record<number, { path: string; before: string | null; after: string } | null>;
  /** Bumped on every webhook.received so the WEBHOOKS tab re-reads /api/webhooks. */
  webhookEpoch: number;
  /** The public tunnel URL (base, no token) when `/serve --public` is up, else null. */
  publicUrl: string | null;
  /** Office-floor placement requests from the model (the `office` tool), each
   * stamped with a monotonic seq so App applies it exactly once. A QUEUE, not a
   * single latest: a fresh connect replays the whole event ring, so several
   * requests can land back-to-back and every one of them has to be seated. The
   * requests are deliberately unresolved — only the floor knows which desks are
   * free. Capped, since a long session must not accumulate them forever. */
  officeQueue: OfficeRequest[];
  /** Live streaming edit per tab (edit.start/line/commit): the right pane of the
   * diff viewer fills in from `lines` until `done`; null when no edit is streaming. */
  streamEdits: Record<number, StreamEdit | null>;
  /** Bumped every time the whole picture is thrown away (floor.reset, or a
   * detected server restart). State the store does not own — manual figures, the
   * debug overlay's figures, the desk selection — is cleared by App off this. */
  floorEpoch: number;
}

/** Chat lines that belong to no single session (the reconnect notice). Shown in
 * the rail whichever session is selected, including when there is none. */
export const GLOBAL_TAB = -1;

/** An office.place / office.clear request, as App consumes it. */
export interface OfficeRequest {
  seq: number;
  action: "place" | "clear";
  /** null = every zone. */
  zone: string | null;
  /** null = fill to capacity. */
  count: number | null;
  names: string[];
  /** thinking | awaiting | speaking | idle | mixed. */
  state: string;
}

/** An in-flight (or just-committed) streaming edit, driving the live diff viewer. */
export interface StreamEdit {
  path: string;
  /** Original file content, split into lines — the static left pane. */
  original: string[];
  /** Total lines expected in the new content (drives the progress bar). */
  totalLines: number;
  /** New-content lines received so far — the right pane fills in from these. */
  lines: { text: string; changed: boolean }[];
  chars: number;
  /** False while streaming (blinking cursor + progress bar); true after edit.commit
   * (diff locked in, undo button shown). */
  done: boolean;
  ok: boolean;
  summary: string;
}

/** One raw chat line before grouping. `rule` marks a code-fence boundary; `text`
 * is a prose/approval line. `kind`: user | assistant | system | approval | tool. */
export interface RawLine {
  key: string; tabId: number; from: string; kind: string; epoch: number; time: string;
  text?: string; rule?: "open" | "close"; lang?: string;
  // approval (kind "approval"): the previewed action, and the answer once resolved.
  permId?: string; label?: string; resolved?: string;
  // ask_user (kind "ask"): the question, its suggested options, and the reply once given.
  askId?: string; question?: string; options?: string[]; answered?: string;
  // outcome (kind "outcome"): the automatic post-turn verdict.
  verdict?: "pass" | "fail" | "unknown"; confidence?: number;
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

const initial: State = { connected: false, agents: {}, order: [], transcripts: {}, running: {}, jobs: {}, subagents: [], links: [], actions: {}, speaking: {}, chatLines: [], turnEpoch: {}, inCode: {}, commands: [], selected: null, permission: null, overlay: null, fileEpoch: 0, jobEpoch: 0, vaultEpoch: 0, connectionsEpoch: 0, goals: {}, reviews: {}, telemetry: {}, plans: {}, designShots: {}, webhookEpoch: 0, publicUrl: null, streamEdits: {}, officeQueue: [], floorEpoch: 0 };

/** Throw the whole picture away: every session tab, transcript, chat line, figure,
 * and pending prompt. Deliberately a reset to `initial` rather than a list of
 * fields to clear — a field added later is then wiped by default, which is the
 * safe direction for "the server this state described is gone".
 *
 * Four things survive, because they describe the CONNECTION rather than the dead
 * session: whether the socket is up, the slash-command registry and tunnel URL the
 * new server re-sends anyway, and the epoch counters that panels watch for changes
 * (rewinding those would leave a panel showing the old server's files or jobs).
 * `notice` adds the dim reconnect line — set on a detected restart, not on the
 * server's own shutdown broadcast, where there is nothing left to read it. */
function resetAll(state: State, notice: string | null): State {
  const next: State = {
    ...initial,
    connected: state.connected,
    commands: state.commands,
    publicUrl: state.publicUrl,
    fileEpoch: state.fileEpoch + 1,
    jobEpoch: state.jobEpoch + 1,
    vaultEpoch: state.vaultEpoch + 1,
    connectionsEpoch: state.connectionsEpoch + 1,
    webhookEpoch: state.webhookEpoch + 1,
    floorEpoch: state.floorEpoch + 1,
  };
  if (!notice) return next;
  return { ...next, chatLines: [{ key: `reset:${state.floorEpoch + 1}`, tabId: GLOBAL_TAB, from: "system", kind: "system", epoch: 0, time: clock(), text: notice }] };
}

/** Fold a tabId-bearing event into that tab's telemetry record. */
function foldTel(state: State, action: { tabId: number } & Parameters<typeof foldTelemetry>[1]): Record<number, Telemetry> {
  return { ...state.telemetry, [action.tabId]: foldTelemetry(state.telemetry[action.tabId], action, Date.now()) };
}

/** Append a raw chat line, capping PER TAB so the feed can't grow unbounded and
 * a busy tab can't evict another tab's history (which would make switching floors
 * show a truncated or empty transcript for the quieter tab). */
function pushLine(state: State, ln: RawLine): State {
  const chatLines = [...state.chatLines, ln];
  const forTab = chatLines.filter((l) => l.tabId === ln.tabId);
  if (forTab.length <= 500) return { ...state, chatLines };
  const dropKeys = new Set(forTab.slice(0, forTab.length - 500).map((l) => l.key)); // keys are globally unique
  return { ...state, chatLines: chatLines.filter((l) => !dropKeys.has(l.key)) };
}

type Action = DomEvent | { type: "@connected"; value: boolean } | { type: "@select"; id: number } | { type: "@clearLink"; key: string } | { type: "@clearSpeaking"; tabId: number } | { type: "@commands"; list: CommandItem[] } | { type: "@restarted"; notice: string };

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
    // The server told us it is going away — nothing it described is live any more.
    case "floor.reset":
      return resetAll(state, null);
    // We found a different server on the port — either by reconnecting to it, or by
    // being turned away by it. Same wipe, plus a line in the rail so the emptiness
    // reads as an event rather than a glitch.
    case "@restarted":
      return resetAll(state, action.notice);
    case "agent.created": {
      if (state.agents[action.tabId]) return state; // snapshot may duplicate
      const agent: Agent = { id: action.tabId, name: action.name, cwd: action.cwd, model: action.model, mode: action.mode, busy: false, cost: 0, tokens: 0, awaitingPermission: false, imageInput: !!action.imageInput, documentInput: !!action.documentInput, contextLimit: action.contextLimit ?? 0 };
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
    case "turn.start":
      return { ...state, telemetry: foldTel(state, action) };
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
        telemetry: foldTel(state, action),
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
      return { ...pushLine(withTx, ln), fileEpoch: state.fileEpoch + 1, vaultEpoch: state.vaultEpoch + 1, telemetry: foldTel(state, action) };
    }
    case "edit.start":
      return {
        ...state,
        streamEdits: {
          ...state.streamEdits,
          [action.tabId]: { path: action.path, original: action.original.split("\n"), totalLines: action.totalLines, lines: [], chars: 0, done: false, ok: false, summary: "" },
        },
      };
    case "edit.line": {
      const cur = state.streamEdits[action.tabId];
      if (!cur || cur.done) return state;
      // edit.line events are ordered by index; append (guard against gaps/dupes).
      const lines = action.index === cur.lines.length ? [...cur.lines, { text: action.text, changed: action.changed }] : cur.lines;
      return { ...state, streamEdits: { ...state.streamEdits, [action.tabId]: { ...cur, lines, chars: action.chars } } };
    }
    case "edit.commit": {
      const cur = state.streamEdits[action.tabId];
      if (!cur) return state;
      return { ...state, streamEdits: { ...state.streamEdits, [action.tabId]: { ...cur, done: true, ok: action.ok, summary: action.summary } } };
    }
    case "task.plan":
      return { ...state, plans: { ...state.plans, [action.tabId]: planFromEvent(action) } };
    case "design.shot":
      return { ...state, designShots: { ...state.designShots, [action.tabId]: { path: action.path, before: action.before, after: action.after } } };
    case "webhook.received":
      return { ...state, webhookEpoch: state.webhookEpoch + 1 };
    case "serve.public":
      return { ...state, publicUrl: action.url };
    case "subagent.start":
      return withItem(
        { ...state, subagents: [...state.subagents, { parentId: action.tabId, description: action.description, key: `${action.tabId}:${action.description}:${state.subagents.length}` }], plans: { ...state.plans, [action.tabId]: foldPlan(state.plans[action.tabId] ?? null, action, Date.now()) } },
        action.tabId,
        { kind: "system", text: `⟳ sub-agent: ${action.description}` },
      );
    case "subagent.end": {
      const i = state.subagents.findIndex((s) => s.parentId === action.tabId && s.description === action.description);
      const subagents = i >= 0 ? state.subagents.filter((_, k) => k !== i) : state.subagents;
      const plans = { ...state.plans, [action.tabId]: foldPlan(state.plans[action.tabId] ?? null, action, Date.now()) };
      return withItem({ ...state, subagents, plans }, action.tabId, { kind: "system", text: `✓ sub-agent done: ${action.description}` });
    }
    case "job.start": {
      const tid = action.tabId ?? state.selected;
      const jobs = action.tabId != null ? { ...state.jobs, [action.tabId]: [...(state.jobs[action.tabId] ?? []), { id: action.jobId, command: action.command }] } : state.jobs;
      const next = { ...state, jobs, jobEpoch: state.jobEpoch + 1, connectionsEpoch: state.connectionsEpoch + 1 };
      return tid == null ? next : withItem(next, tid, { kind: "system", text: `⎈ job ${action.jobId}: ${action.command}` });
    }
    case "job.end": {
      const tid = action.tabId ?? state.selected;
      const jobs = action.tabId != null ? { ...state.jobs, [action.tabId]: (state.jobs[action.tabId] ?? []).filter((j) => j.id !== action.jobId) } : state.jobs;
      const next = { ...state, jobs, jobEpoch: state.jobEpoch + 1, connectionsEpoch: state.connectionsEpoch + 1 };
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
    case "turn.outcome": {
      const from = state.agents[action.tabId]?.name ?? `#${action.tabId}`;
      const epoch = state.turnEpoch[action.tabId] ?? 0;
      const ln: RawLine = {
        key: `o${action.tabId}:${epoch}`, tabId: action.tabId, from, kind: "outcome", epoch, time: clock(),
        text: action.line, verdict: action.verdict, confidence: action.confidence ?? undefined,
      };
      return pushLine(state, ln);
    }
    case "ask.request": {
      const from = state.agents[action.tabId]?.name ?? `#${action.tabId}`;
      const epoch = state.turnEpoch[action.tabId] ?? 0;
      const ln: RawLine = {
        key: `q${action.id}`, tabId: action.tabId, from, kind: "ask", epoch, time: clock(),
        askId: action.id, question: action.question, options: action.options,
      };
      return pushLine(state, ln);
    }
    case "ask.resolved": {
      // Whichever client answered, every card for this question settles.
      const chatLines = state.chatLines.map((l) =>
        l.askId === action.id ? { ...l, answered: action.answer || "(skipped — agent decided)" } : l,
      );
      return { ...state, chatLines };
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
    case "office.place":
      return { ...state, officeQueue: pushOfficeRequest<Omit<OfficeRequest, "seq">>(state.officeQueue, { action: "place", zone: action.zone, count: action.count, names: action.names, state: action.state }) };
    case "office.clear":
      return { ...state, officeQueue: pushOfficeRequest<Omit<OfficeRequest, "seq">>(state.officeQueue, { action: "clear", zone: null, count: null, names: [], state: "idle" }) };
    case "vault.changed":
      return { ...state, vaultEpoch: state.vaultEpoch + 1 };
    case "connections.changed":
      return { ...state, connectionsEpoch: state.connectionsEpoch + 1 };
    case "goal.state":
      return { ...state, goals: { ...state.goals, [action.tabId]: action.goal } };
    case "goal.review": {
      const review: GoalReview = { verdict: action.verdict, text: action.text, roundsLeft: action.roundsLeft, active: action.active };
      // Keep the goal bar's round counter in sync with the review outcome.
      const goal = state.goals[action.tabId];
      const goals = goal ? { ...state.goals, [action.tabId]: { ...goal, roundsLeft: action.roundsLeft, active: action.active } } : state.goals;
      const next = withItem({ ...state, goals, reviews: { ...state.reviews, [action.tabId]: review } }, action.tabId, {
        kind: "system",
        text: action.verdict === "pass" ? `✓ goal review: PASS` : `✗ goal review: ${action.verdict.toUpperCase()} — ${action.text.split("\n")[0]}`,
      });
      return next;
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
  /** The server instance this page is currently in sync with (from server.hello). */
  const instanceRef = useRef<string | null>(null);
  /** Latched once the token has been found stale, so the notice is not repeated on
   * every retry of a reconnect that can never succeed. */
  const staleRef = useRef(false);
  // Pending @-file requests keyed by reqId (resolved when the server replies).
  const filesRef = useRef<{ seq: number; pending: Map<number, (list: string[]) => void> }>({ seq: 0, pending: new Map() });
  // Pending vault.save requests keyed by reqId (resolved by the vault.saved ack).
  const vaultRef = useRef<{ seq: number; pending: Map<number, (r: SaveResult) => void> }>({ seq: 0, pending: new Map() });

  useEffect(() => {
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const token = new URLSearchParams(location.search).get("token") ?? "";
      const proto = location.protocol === "https:" ? "wss" : "ws";
      // The cursor travels with the instance it was counted against, so the server
      // can tell "resume where I left off" from "that was a different server".
      const since = lastSeqRef.current != null ? `&since=${lastSeqRef.current}` : "";
      const inst = instanceRef.current != null ? `&instance=${encodeURIComponent(instanceRef.current)}` : "";
      const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}${since}${inst}`);
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        dispatch({ type: "@connected", value: true });
      };
      ws.onclose = () => {
        dispatch({ type: "@connected", value: false });
        if (closed) return;
        retry = Math.min(retry + 1, 6);
        // The other way a restart reaches an already-open tab. `serve` mints a new
        // token every run, so the link in this tab's address bar is dead and the
        // socket will be refused forever — the reconnect that would have carried
        // server.hello never happens. A rejected upgrade looks exactly like an
        // unreachable host from here, so ask over HTTP which it is, once the retries
        // suggest this is not a blip. A 401 means someone else is on the port and
        // the session we are drawing is gone.
        if (retry === 3 && !staleRef.current) {
          void tokenRejected().then((rejected) => {
            if (closed || !rejected || staleRef.current) return;
            staleRef.current = true;
            dispatch({ type: "@restarted", notice: "server restarted — open the new link to reconnect" });
          });
        }
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
        // First frame of every connection: which server instance this is. A change
        // means the session we were drawing died with the old process, so the whole
        // picture goes before the new server's snapshot arrives behind this frame.
        // The very first hello only records the identity — a page load has nothing
        // to throw away, and announcing a "restart" for it would be a lie.
        if ((ev as any).type === "server.hello") {
          const seen = (ev as any).instance;
          const prev = instanceRef.current;
          instanceRef.current = seen;
          if (prev != null && prev !== seen) {
            lastSeqRef.current = null; // the old cursor counts events this server never sent
            dispatch({ type: "@restarted", notice: "server restarted — reconnected" });
          }
          return;
        }
        if ((ev as any).type === "commands") { dispatch({ type: "@commands", list: (ev as any).list ?? [] }); return; }
        if ((ev as any).type === "files") { const r = filesRef.current.pending.get((ev as any).reqId); if (r) { filesRef.current.pending.delete((ev as any).reqId); r((ev as any).list ?? []); } return; }
        if ((ev as any).type === "vault.saved") { const r = vaultRef.current.pending.get((ev as any).reqId); if (r) { vaultRef.current.pending.delete((ev as any).reqId); r({ ok: !!(ev as any).ok, path: (ev as any).path, error: (ev as any).error }); } return; }
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

  // "Save to vault": write a chat message as a new note; resolves with the ack. An
  // optional folder (Code/Research/Decisions) routes auto-saved notes into subfolders.
  const saveVault = useCallback((filename: string, tags: string[], content: string, folder?: string): Promise<SaveResult> => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, error: "not connected" });
    const reqId = ++vaultRef.current.seq;
    return new Promise<SaveResult>((resolve) => {
      vaultRef.current.pending.set(reqId, resolve);
      setTimeout(() => { if (vaultRef.current.pending.delete(reqId)) resolve({ ok: false, error: "timed out" }); }, 8000);
      ws.send(JSON.stringify({ type: "vault.save", reqId, filename, tags, content, folder }));
    });
  }, []);

  return { state, send, select, requestFiles, saveVault };
}

export interface SaveResult { ok: boolean; path?: string; error?: string }

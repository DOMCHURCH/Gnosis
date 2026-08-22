// The event bus: a single, synchronous, in-process fan-out that every Engine (via
// the tabs controller) emits to. The Ink TUI keeps rendering from its own
// callbacks; the web server subscribes here and forwards to browsers. One source
// of truth, no second agent loop.
//
// "Emit and forget": emit() must never slow the agent loop, so each listener is
// called in a try/catch and is expected to do only cheap work (push to a buffer,
// write to a socket). Anything heavier a listener does on its own time.

import type { PermissionAnswer } from "./permissions.js";
import { COMMANDS } from "./commands.js";

/** A snapshot of one agent (tab), sent to a client when it first connects. */
export interface AgentSnapshot {
  id: number;
  name: string;
  cwd: string;
  model: string;
  mode: string;
  busy: boolean;
}

/** Every event the bus can carry. `unknown` payloads (preview/item/args) are
 * passed straight through and JSON-serialized by the server — the bus does not
 * couple to their concrete shapes. */
export type DomEvent =
  | { type: "agent.created"; tabId: number; name: string; cwd: string; model: string; mode: string }
  | { type: "agent.closed"; tabId: number; name: string }
  | { type: "agent.mode"; tabId: number; mode: string }
  | { type: "agent.busy"; tabId: number; busy: boolean }
  | { type: "turn.start"; tabId: number }
  | { type: "turn.end"; tabId: number; cost: number; tokens: number }
  | { type: "line"; tabId: number; item: unknown }
  | { type: "tool.start"; tabId: number; tool: string; args: unknown }
  | { type: "tool.end"; tabId: number; tool: string; primary: string; secondary: string; ok: boolean; summary: string; detail: string }
  | { type: "subagent.start"; tabId: number; description: string }
  | { type: "subagent.end"; tabId: number; description: string; result: string }
  | { type: "permission.request"; tabId: number; id: string; preview: unknown; options: string[] }
  | { type: "permission.resolved"; tabId: number; id: string; answer: string }
  | { type: "overlay.open"; tabId: number; id: string; kind: string; title: string; items: { value: string; label: string }[]; selected: string | null }
  | { type: "overlay.resolved"; id: string }
  | { type: "job.start"; tabId: number | null; jobId: string; command: string }
  | { type: "job.end"; tabId: number | null; jobId: string; status: string; exitCode: number | null }
  | { type: "message.sent"; from: string; to: string; hops: number }
  | { type: "goal.state"; tabId: number; goal: { text: string; active: boolean; roundsLeft: number; maxRounds: number; reviewModel?: string } | null }
  | { type: "goal.review"; tabId: number; verdict: string; text: string; roundsLeft: number; active: boolean };

export type Listener = (e: DomEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Fan out to every listener. Synchronous and exception-isolated: a throwing or
   * slow-by-mistake listener can neither break nor block the emitter. */
  emit(e: DomEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* a broken subscriber must never affect the agent loop */
      }
    }
  }
}

/**
 * The bridge between the running app (engines + tabs controller, owned by the Ink
 * UI) and remote clients (the web server). The UI populates the handler slots when
 * it mounts in `dom serve`; the server calls them for client→server messages. This
 * keeps the web a remote control over the SAME engines — never a second agent.
 */
export interface AppBridge {
  bus: EventBus;
  /** Current agents, sent to a client on connect so it starts in sync. */
  getAgents(): AgentSnapshot[];
  /** The slash-command registry (same one the TUI's /help uses), sent on connect. */
  getCommands(): { name: string; args?: string; desc: string }[];

  // Client → server actions (set by the UI; absent until it mounts).
  onInput?(tabId: number, text: string): void;
  onCommand?(tabId: number, command: string): void;
  onCreateAgent?(name?: string, purpose?: string): void;
  onCloseAgent?(tabId: number): void;
  /** @-autocomplete: ranked file paths under the tab's cwd matching `query`. */
  onFiles?(tabId: number, query: string): Promise<string[]>;
  /** Goal bar: set/update or clear a tab's standing goal (web UI). */
  onGoalSet?(tabId: number, goal: { text: string; maxRounds?: number; reviewModel?: string; active?: boolean }): void;
  onGoalClear?(tabId: number): void;

  // Permission coordination. The engine registers a pending request keyed by id;
  // either the TUI overlay or a web client resolves it (first wins).
  registerPermission(id: string, resolve: (a: PermissionAnswer) => void): void;
  clearPermission(id: string): void;
  answerPermission(id: string, answer: PermissionAnswer): void;

  // Overlay coordination (selection UI: /model, /resume, @-file, Ctrl+R history).
  // Same first-to-answer model as permissions, but the pickers live in the UI, so
  // the UI registers the resolver here; a web client answers via answerOverlay. A
  // string is the chosen value; null is a cancel.
  registerOverlay(id: string, resolve: (value: string | null) => void): void;
  clearOverlay(id: string): void;
  answerOverlay(id: string, value: string | null): void;
}

/** Build a bridge with the permission registry wired; the UI fills the rest. */
export function createBridge(bus: EventBus): AppBridge {
  const pending = new Map<string, (a: PermissionAnswer) => void>();
  const overlays = new Map<string, (value: string | null) => void>();
  return {
    bus,
    getAgents: () => [],
    getCommands: () => COMMANDS,
    registerPermission: (id, resolve) => {
      pending.set(id, resolve);
    },
    clearPermission: (id) => {
      pending.delete(id);
    },
    answerPermission: (id, answer) => {
      const resolve = pending.get(id);
      if (resolve) resolve(answer);
    },
    registerOverlay: (id, resolve) => {
      overlays.set(id, resolve);
    },
    clearOverlay: (id) => {
      overlays.delete(id);
    },
    answerOverlay: (id, value) => {
      const resolve = overlays.get(id);
      if (resolve) resolve(value);
    },
  };
}

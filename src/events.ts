// The event bus: a single, synchronous, in-process fan-out that every Engine (via
// the tabs controller) emits to. The Ink TUI keeps rendering from its own
// callbacks; the web server subscribes here and forwards to browsers. One source
// of truth, no second agent loop.
//
// "Emit and forget": emit() must never slow the agent loop, so each listener is
// called in a try/catch and is expected to do only cheap work (push to a buffer,
// write to a socket). Anything heavier a listener does on its own time.

import type { PermissionAnswer } from "./permissions.js";

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
  | { type: "tool.end"; tabId: number; tool: string; primary: string; secondary: string; ok: boolean; summary: string }
  | { type: "subagent.start"; tabId: number; description: string }
  | { type: "subagent.end"; tabId: number; description: string; result: string }
  | { type: "permission.request"; tabId: number; id: string; preview: unknown; options: string[] }
  | { type: "permission.resolved"; tabId: number; id: string; answer: string }
  | { type: "job.start"; tabId: number | null; jobId: string; command: string }
  | { type: "job.end"; tabId: number | null; jobId: string; status: string; exitCode: number | null }
  | { type: "message.sent"; from: string; to: string; hops: number };

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

  // Client → server actions (set by the UI; absent until it mounts).
  onInput?(tabId: number, text: string): void;
  onCommand?(tabId: number, command: string): void;
  onCreateAgent?(name?: string, purpose?: string): void;
  onCloseAgent?(tabId: number): void;

  // Permission coordination. The engine registers a pending request keyed by id;
  // either the TUI overlay or a web client resolves it (first wins).
  registerPermission(id: string, resolve: (a: PermissionAnswer) => void): void;
  clearPermission(id: string): void;
  answerPermission(id: string, answer: PermissionAnswer): void;
}

/** Build a bridge with the permission registry wired; the UI fills the rest. */
export function createBridge(bus: EventBus): AppBridge {
  const pending = new Map<string, (a: PermissionAnswer) => void>();
  return {
    bus,
    getAgents: () => [],
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
  };
}

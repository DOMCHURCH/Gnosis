// Multi-session tabs. Each tab is its own Engine (own history, model, cwd, and
// permission mode). This controller owns the tab set, the active tab, and — the
// part that matters most — inter-agent messaging with loop prevention:
//   1. hop counter: a message carries sender.hops + 1; rejected above MAX_HOPS.
//   2. no immediate reply: a tab may not message the tab whose message it is
//      currently processing, within that same turn.
//   3. global cap: at most MAX_MESSAGES inter-agent messages per session.
// The controller is framework-agnostic; the UI subscribes via onChange and
// supplies the turn `executor` (which builds the per-tab callbacks + engine.run).

import type { Engine } from "./engine.js";
import type { TabRuntime } from "./tools/index.js";
import type { Preview, PermissionAnswer } from "./permissions.js";

export const MAX_HOPS = 3;
export const MAX_MESSAGES = 20;

export type Badge = "none" | "output" | "approval";

export interface QueuedMessage {
  from: string;
  text: string;
  hops: number;
}

export interface PendingPermission {
  preview: Preview;
  resolve: (answer: PermissionAnswer) => void;
}

export interface Tab {
  id: number;
  name: string;
  /** One-line purpose set at /new; surfaced by list_tabs. */
  purpose: string;
  engine: Engine;
  badge: Badge;
  busy: boolean;
  queue: QueuedMessage[];
  /** Hops of the message currently being processed (0 for a human turn). */
  currentHops: number;
  /** Name of the tab the current message arrived from (null for a human turn). */
  currentSender: string | null;
  /** A permission request raised while this tab was in the background. */
  pendingPermission: PendingPermission | null;
}

/** Runs one turn for a tab (build callbacks + engine.run). Supplied by the UI. */
export type Executor = (tab: Tab, userText: string) => Promise<void>;

export interface RouteResult {
  ok: boolean;
  message: string;
}

export class TabsController {
  readonly tabs: Tab[] = [];
  activeId: number;
  messageCount = 0;
  private nextId = 1;
  private readonly root: Engine;
  private executor: Executor;
  private onChange: () => void;

  constructor(root: Engine, rootName: string, executor: Executor, onChange: () => void) {
    this.root = root;
    this.executor = executor;
    this.onChange = onChange;
    const tab = this.makeTab(rootName, "", root);
    this.tabs.push(tab);
    this.activeId = tab.id;
  }

  // --- lookups ---------------------------------------------------------------

  active(): Tab {
    return this.byId(this.activeId)!;
  }
  byId(id: number): Tab | undefined {
    return this.tabs.find((t) => t.id === id);
  }
  byName(name: string): Tab | undefined {
    const n = name.trim().toLowerCase();
    return this.tabs.find((t) => t.name.toLowerCase() === n);
  }
  index(id: number): number {
    return this.tabs.findIndex((t) => t.id === id);
  }

  // --- lifecycle -------------------------------------------------------------

  private makeTab(name: string, purpose: string, engine: Engine): Tab {
    const tab: Tab = {
      id: this.nextId++,
      name,
      purpose,
      engine,
      badge: "none",
      busy: false,
      queue: [],
      currentHops: 0,
      currentSender: null,
      pendingPermission: null,
    };
    engine.toolContext = { tab: this.runtimeFor(tab) };
    return tab;
  }

  private uniqueName(base: string): string {
    let name = base.trim() || `tab${this.nextId}`;
    if (!this.byName(name)) return name;
    let n = 2;
    while (this.byName(`${name}${n}`)) n++;
    return `${name}${n}`;
  }

  /** Create a new tab (its own forked Engine). Does not switch to it. */
  create(name?: string, purpose = ""): Tab {
    const tab = this.makeTab(this.uniqueName(name ?? `tab${this.nextId}`), purpose, this.root.fork());
    this.tabs.push(tab);
    this.onChange();
    return tab;
  }

  /** Close a tab. Refuses to close the last one. Returns the now-active tab. */
  close(id: number): Tab {
    if (this.tabs.length <= 1) return this.active();
    const i = this.index(id);
    if (i === -1) return this.active();
    const closingActive = id === this.activeId;
    const tab = this.tabs[i]!;
    tab.engine.abort();
    // Reject any parked permission so its promise doesn't dangle.
    tab.pendingPermission?.resolve("no");
    this.tabs.splice(i, 1);
    if (closingActive) {
      const next = this.tabs[Math.max(0, i - 1)]!;
      this.setActive(next.id);
    } else {
      this.onChange();
    }
    return this.active();
  }

  /** Make a tab active: clears its badge (it's now visible). Each tab's engine
   * owns its own cwd, so no process.chdir is needed — tools resolve against the
   * engine's cwd via ctx, and interleaved turns from different tabs never clash. */
  setActive(id: number): void {
    const tab = this.byId(id);
    if (!tab) return;
    this.activeId = id;
    tab.badge = "none";
    this.onChange();
  }

  /** Switch by 1-based position (Ctrl+1..9). No-op if out of range. */
  setActiveByIndex(pos: number): void {
    const tab = this.tabs[pos - 1];
    if (tab) this.setActive(tab.id);
  }

  // --- badges / permissions --------------------------------------------------

  /** A background tab produced output — badge it (unless it already needs approval). */
  markOutput(tab: Tab): void {
    if (tab.id !== this.activeId && tab.badge !== "approval") {
      tab.badge = "output";
      this.onChange();
    }
  }

  /** Park a permission request raised by a background tab: badge amber, keep focus. */
  setPendingPermission(tab: Tab, pp: PendingPermission): void {
    tab.pendingPermission = pp;
    if (tab.id !== this.activeId) tab.badge = "approval";
    this.onChange();
  }

  takePendingPermission(tab: Tab): PendingPermission | null {
    const pp = tab.pendingPermission;
    tab.pendingPermission = null;
    return pp;
  }

  // --- turns -----------------------------------------------------------------

  private formatIncoming(msg: QueuedMessage): string {
    return `[message from ${msg.from}]\n${msg.text}`;
  }

  private async runTurnWith(
    tab: Tab,
    hops: number,
    sender: string | null,
    fn: () => Promise<void>,
  ): Promise<void> {
    tab.busy = true;
    tab.currentHops = hops;
    tab.currentSender = sender;
    this.onChange();
    try {
      await fn();
    } catch {
      /* the executor/engine surfaces its own errors */
    } finally {
      tab.busy = false;
      tab.currentHops = 0;
      tab.currentSender = null;
      this.onChange();
      const next = tab.queue.shift();
      if (next) void this.runTurnWith(tab, next.hops, next.from, () => this.executor(tab, this.formatIncoming(next)));
    }
  }

  /** A human-typed message in the active tab (hop 0, no sender). */
  submitUser(tab: Tab, text: string): void {
    if (tab.busy) return;
    void this.runTurnWith(tab, 0, null, () => this.executor(tab, text));
  }

  /** Run an arbitrary foreground action as a human turn (e.g. a `!command`). */
  runForeground(tab: Tab, fn: () => Promise<void>): void {
    if (tab.busy) return;
    void this.runTurnWith(tab, 0, null, fn);
  }

  private dispatch(tab: Tab): void {
    if (tab.busy) return; // a running turn will drain the queue in its finally block
    const msg = tab.queue.shift();
    if (msg) void this.runTurnWith(tab, msg.hops, msg.from, () => this.executor(tab, this.formatIncoming(msg)));
  }

  // --- messaging + loop prevention ------------------------------------------

  /** Route a message from one tab to another, enforcing all three loop guards.
   * On success it enqueues into the target and triggers a turn there. */
  route(fromName: string, toName: string, text: string): RouteResult {
    const from = this.byName(fromName);
    const to = this.byName(toName);
    if (!to) return { ok: false, message: `no tab named "${toName}" — use list_tabs to see open tabs.` };
    if (from && to.id === from.id) return { ok: false, message: "a tab cannot message itself." };

    // Guard 2: no reply to the tab whose message we're processing this turn.
    if (from && from.currentSender && from.currentSender.toLowerCase() === to.name.toLowerCase()) {
      return {
        ok: false,
        message: `cannot reply to "${to.name}" in the same turn — it is the tab this message just arrived from. Message a different tab or wait for the user.`,
      };
    }

    // Guard 1: hop limit.
    const hops = (from?.currentHops ?? 0) + 1;
    if (hops > MAX_HOPS) {
      return {
        ok: false,
        message: `message to "${to.name}" rejected: this would be hop ${hops}, over the ${MAX_HOPS}-hop limit. Loop stopped.`,
      };
    }

    // Guard 3: global per-session cap.
    if (this.messageCount >= MAX_MESSAGES) {
      return { ok: false, message: `inter-agent message cap (${MAX_MESSAGES}/session) reached — hard stop.` };
    }

    this.messageCount++;
    to.queue.push({ from: fromName, text, hops });
    if (to.id !== this.activeId && to.badge !== "approval") to.badge = "output";
    this.onChange();
    this.dispatch(to);
    return { ok: true, message: `delivered to "${to.name}" (hop ${hops}).` };
  }

  private runtimeFor(tab: Tab): TabRuntime {
    return {
      selfName: () => tab.name,
      sendMessage: (to, text) => this.route(tab.name, to, text),
      listTabs: () =>
        this.tabs.map((t) => ({
          name: t.name,
          purpose: t.purpose,
          active: t.id === this.activeId,
          busy: t.busy,
        })),
    };
  }
}

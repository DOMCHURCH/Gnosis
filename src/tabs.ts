// Multi-session tabs. Each tab is its own Engine (own history, model, cwd, and
// permission mode). This controller owns the tab set, the active tab, and — the
// part that matters most — inter-agent messaging with loop prevention:
//   1. hop counter: a message carries sender.hops + 1; rejected above MAX_HOPS.
//   2. no immediate reply: a tab may not message the tab whose message it is
//      currently processing, within that same turn.
//   3. global cap: at most MAX_MESSAGES inter-agent messages per session.
// The controller is framework-agnostic; the UI subscribes via onChange and
// supplies the turn `executor` (which builds the per-tab callbacks + engine.run).

import path from "node:path";
import type { Engine } from "./engine.js";
import type { TabRuntime } from "./tools/index.js";
import type { Preview, PermissionAnswer } from "./permissions.js";
import type { EventBus, AppBridge } from "./events.js";

export const MAX_HOPS = 3;
export const MAX_MESSAGES = 20;

export type Badge = "none" | "output" | "approval";

export interface QueuedMessage {
  from: string;
  text: string;
  hops: number;
  /** A raw follow-up (e.g. a goal-review steer): run verbatim, no "[message from]"
   * prefix. */
  raw?: boolean;
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
  /** Event bus for the web view (`dom serve`); undefined in a plain TUI run until
   * `/serve` attaches one (see attachBus). */
  private bus?: EventBus;
  private bridge?: AppBridge;

  constructor(root: Engine, rootName: string, executor: Executor, onChange: () => void, bus?: EventBus, bridge?: AppBridge) {
    this.root = root;
    this.executor = executor;
    this.onChange = onChange;
    this.bus = bus;
    this.bridge = bridge;
    const tab = this.makeTab(rootName, "", root);
    this.tabs.push(tab);
    this.activeId = tab.id;
    this.emitCreated(tab);
  }

  /** Attach an event bus + bridge to a controller that started without one (a plain
   * TUI run that later ran `/serve`). Wires every existing engine so its turns,
   * tools, sub-agents, and permissions emit, and re-announces the current tabs so a
   * client that connects sees them (getAgents also covers the connect snapshot). */
  attachBus(bus: EventBus, bridge: AppBridge): void {
    this.bus = bus;
    this.bridge = bridge;
    for (const tab of this.tabs) {
      tab.engine.bus = bus;
      tab.engine.bridge = bridge;
      this.emitCreated(tab);
    }
  }

  private emitCreated(tab: Tab): void {
    this.bus?.emit({
      type: "agent.created",
      tabId: tab.id,
      name: tab.name,
      cwd: tab.engine.cwd,
      model: tab.engine.modelId,
      mode: tab.engine.mode,
      imageInput: tab.engine.supportsImageInput(),
      documentInput: tab.engine.supportsDocumentInput(),
      contextLimit: tab.engine.contextLength(),
    });
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
    // Wire the engine to the bus so its turns/tools/sub-agents/permissions emit.
    engine.bus = this.bus;
    engine.bridge = this.bridge;
    engine.agentId = tab.id;
    engine.agentName = tab.name;
    return tab;
  }

  private uniqueName(base: string): string {
    let name = base.trim() || `tab${this.nextId}`;
    if (!this.byName(name)) return name;
    let n = 2;
    while (this.byName(`${name}${n}`)) n++;
    return `${name}${n}`;
  }

  /** Create a new tab (its own forked Engine). Does not switch to it. A `cwd`
   * roots the tab's engine elsewhere (e.g. a git worktree) instead of the root's. */
  create(name?: string, purpose = "", cwd?: string): Tab {
    const engine = this.root.fork(cwd ? { cwd } : undefined);
    // Default (nameless) sessions take the cwd basename, not a bare number.
    const base = path.basename(engine.cwd) || `tab${this.nextId}`;
    const tab = this.makeTab(this.uniqueName(name ?? base), purpose, engine);
    this.tabs.push(tab);
    this.emitCreated(tab);
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
    this.bus?.emit({ type: "agent.closed", tabId: tab.id, name: tab.name });
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
    return msg.raw ? msg.text : `[message from ${msg.from}]\n${msg.text}`;
  }

  /**
   * Goal bar: after a turn ends, run the read-only reviewer over `git diff HEAD`
   * vs the tab's standing goal (never the conversation). Report the verdict on the
   * bus (the web shows PASS/FAIL above the chat rail) and, on a FAIL with rounds
   * left, front-load a steer so the tab immediately works the goal again. Called
   * from runTurnWith's finally, before the queue drains, so the steer runs next.
   */
  private async reviewGoal(tab: Tab): Promise<void> {
    const engine = tab.engine;
    if (!this.bus || typeof engine.runGoalReview !== "function") return;
    if (!engine.goal?.active) return;
    let outcome;
    try {
      outcome = await engine.runGoalReview();
    } catch {
      return; // a review must never break the turn lifecycle
    }
    if (!outcome) return;
    this.bus.emit({ type: "goal.review", tabId: tab.id, verdict: outcome.verdict, text: outcome.text, roundsLeft: outcome.roundsLeft, active: outcome.active });
    if (outcome.steer) tab.queue.unshift({ from: "goal", text: outcome.steer, hops: 0, raw: true });
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
    // Per-turn cost/token delta for turn.end (the engine folds cumulative totals).
    // Only touched when the bus is active — a bare test engine may lack .cost.
    const c0 = this.bus ? tab.engine.cost : undefined;
    const startUsd = c0?.usd ?? 0;
    const startTok = c0 ? c0.promptTokens + c0.completionTokens : 0;
    const startCached = c0 ? c0.cachedPromptTokens ?? 0 : 0;
    this.bus?.emit({ type: "agent.busy", tabId: tab.id, busy: true });
    this.bus?.emit({ type: "turn.start", tabId: tab.id });
    this.onChange();
    try {
      await fn();
    } catch {
      /* the executor/engine surfaces its own errors */
    } finally {
      tab.busy = false;
      tab.currentHops = 0;
      tab.currentSender = null;
      if (this.bus) {
        const c1 = tab.engine.cost;
        this.bus.emit({ type: "turn.end", tabId: tab.id, cost: (c1?.usd ?? 0) - startUsd, tokens: (c1 ? c1.promptTokens + c1.completionTokens : 0) - startTok, cachedTokens: (c1 ? c1.cachedPromptTokens ?? 0 : 0) - startCached });
        this.bus.emit({ type: "agent.busy", tabId: tab.id, busy: false });
      }
      this.onChange();
      // Goal bar: judge the diff vs the goal and, on FAIL, enqueue a steer (which
      // the drain below picks up, running another round).
      await this.reviewGoal(tab);
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
    this.bus?.emit({ type: "message.sent", from: fromName, to: to.name, hops });
    this.onChange();
    this.dispatch(to);
    return { ok: true, message: `delivered to "${to.name}" (hop ${hops}).` };
  }

  private runtimeFor(tab: Tab): TabRuntime {
    return {
      selfName: () => tab.name,
      selfId: () => tab.id,
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

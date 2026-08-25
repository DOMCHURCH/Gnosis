// Dreaming: long-horizon tasks that run autonomously in the background while you
// keep working. A dream owns its own Engine — its own history, model, and session —
// so it never competes with the foreground tab for context.
//
// Three rules shape everything here:
//
//  1. A dream must be able to run unattended, so it approves ordinary tool calls
//     itself. It must NOT be able to run away, so dangerous calls still stop and
//     ask, and three hard caps (iterations, dollars, wall time) end it cleanly.
//  2. A dream must never outlive the process. Every dream is registered in a
//     module-level set that stopAll() drains, and the CLI wires that to SIGINT and
//     process exit — an orphaned agent burning tokens after Ctrl+C is the worst
//     failure this feature could have.
//  3. A dream's record must survive a restart, so the state that matters is
//     written to disk on every transition, not held only in memory.

import path from "node:path";
import { promises as fs } from "node:fs";
import { Engine, type Callbacks } from "./engine.js";
import { notify } from "./notify.js";
import type { EventBus } from "./events.js";
import type { PermissionAnswer, Preview } from "./permissions.js";

/** Hard caps. A dream that hits any one of these stops cleanly and says which. */
export const DREAM_MAX_ITERATIONS = 50;
export const DREAM_MAX_USD = 2;
export const DREAM_MAX_MS = 2 * 60 * 60 * 1000; // 2 hours
/** How long a dream waits on a question before answering itself and moving on. */
export const DREAM_ASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
/** How long a dream waits for approval of a dangerous call before denying it. */
export const DREAM_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export type DreamStatus = "running" | "done" | "stopped" | "capped" | "failed";

export interface DreamRecord {
  id: string;
  task: string;
  status: DreamStatus;
  cwd: string;
  model: string;
  startedAt: number;
  endedAt: number | null;
  usd: number;
  iterations: number;
  /** One line: the dream's own closing summary, or why it ended. */
  summary: string;
}

/** Everything a dream needs from the host to run and to reach the user. */
export interface DreamDeps {
  /** Forks the engine the dream runs on (its own history + session). */
  fork: (cwd?: string) => Engine;
  bus?: EventBus;
  /** Raise a dangerous-call approval that the TUI or a browser can answer. */
  requestApproval?: (dreamId: string, preview: Preview) => Promise<PermissionAnswer>;
  /** Put a question to the user (ask_user from inside a dream). */
  askUser?: (dreamId: string, question: string, options: string[]) => Promise<string>;
  notifyEnabled?: boolean;
  /** Injected in tests so the suite doesn't wait ten real minutes. */
  askTimeoutMs?: number;
  approvalTimeoutMs?: number;
}

/**
 * Every timeout currently armed inside a dream, so shutdown can clear them.
 *
 * These are deliberately NOT unref'd. An unref'd timer only fires if something
 * else is keeping the event loop alive, and a dream parked on an unanswered
 * question has nothing else running — exactly the case the timeout exists for. A
 * ref'd timer is reliable; stopAll() clears them so a pending one can't hold the
 * process open after the user quits.
 */
const PENDING_TIMERS = new Set<ReturnType<typeof setTimeout>>();

function clearPendingTimers(): void {
  for (const t of PENDING_TIMERS) clearTimeout(t);
  PENDING_TIMERS.clear();
}

/** Resolve `p`, or `fallback` after `ms` — used for every wait a dream can do, so
 *  nothing inside a dream can block forever. */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const done = (v: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      PENDING_TIMERS.delete(timer);
      resolve(v);
    };
    const timer = setTimeout(() => done(fallback), ms);
    PENDING_TIMERS.add(timer);
    void p.then(done, () => done(fallback));
  });
}

function dreamsFile(home: string): string {
  return path.join(home, "dreams.json");
}

/** Read the persisted dream log. Missing/corrupt file reads as empty — a broken
 *  log must never stop the agent from starting. */
export async function loadDreams(home: string): Promise<DreamRecord[]> {
  try {
    const raw = await fs.readFile(dreamsFile(home), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DreamRecord[]) : [];
  } catch {
    return [];
  }
}

export async function saveDreams(home: string, records: DreamRecord[]): Promise<void> {
  try {
    await fs.mkdir(home, { recursive: true });
    // Keep the log bounded: the 50 most recent, newest first.
    const trimmed = [...records].sort((a, b) => b.startedAt - a.startedAt).slice(0, 50);
    await fs.writeFile(dreamsFile(home), JSON.stringify(trimmed, null, 2), "utf8");
  } catch {
    /* a log we can't write is not a reason to fail the dream */
  }
}

/** Which cap (if any) this dream has hit. */
export function capHit(rec: DreamRecord, now: number): string | null {
  if (rec.iterations >= DREAM_MAX_ITERATIONS) return `${DREAM_MAX_ITERATIONS}-iteration cap`;
  if (rec.usd >= DREAM_MAX_USD) return `$${DREAM_MAX_USD} budget`;
  if (now - rec.startedAt >= DREAM_MAX_MS) return "2-hour time limit";
  return null;
}

/** One line per dream for `/dreams`. */
export function formatDream(d: DreamRecord, now = Date.now()): string {
  const mins = Math.round(((d.endedAt ?? now) - d.startedAt) / 60000);
  const cost = `$${d.usd.toFixed(4)}`;
  const head = `${d.id}  ${d.status.padEnd(7)}  ${cost.padStart(8)}  ${String(mins).padStart(3)}m  ${d.task.slice(0, 44)}`;
  return d.summary ? `${head}\n      ↳ ${d.summary}` : head;
}

/**
 * Every manager in the process. Rule 2 from the header: a dream must never outlive
 * the process that spawned it, so cleanup is installed HERE rather than left to a
 * UI unmount that may not run — an orphaned agent burning tokens after Ctrl+C is
 * the worst failure this feature could have.
 */
const MANAGERS = new Set<DreamManager>();
let hooksInstalled = false;

function installExitHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const drain = () => { for (const m of MANAGERS) m.stopAll(); };
  process.on("exit", drain);
  // Ink runs with exitOnCtrlC:false, so SIGINT reaches us; stop dreams and let
  // whatever else is listening decide whether the process itself should end.
  process.on("SIGINT", drain);
  process.on("SIGTERM", drain);
  // A crash still gets one chance to stop the loops before the process dies.
  process.on("uncaughtException", (e) => { drain(); throw e; });
}

/** Stop every dream in the process. Exported for tests and explicit shutdown. */
export function stopAllDreams(): void {
  for (const m of MANAGERS) m.stopAll();
}

interface Live {
  rec: DreamRecord;
  engine: Engine;
  abort: () => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Owns every dream in the process. One instance per app; the CLI wires stopAll()
 * to SIGINT and exit so nothing survives the process that spawned it.
 */
export class DreamManager {
  private live = new Map<string, Live>();
  private records: DreamRecord[] = [];
  private seq = 1;

  constructor(private home: string, private deps: DreamDeps) {
    MANAGERS.add(this);
    installExitHooks();
  }

  /** Detach from the process-level cleanup (the app is shutting this one down). */
  dispose(): void {
    this.stopAll();
    MANAGERS.delete(this);
  }

  /** Load the persisted log. Any dream still marked `running` belongs to a process
   *  that is gone, so it is reconciled to `stopped` rather than silently resumed —
   *  we cannot resume an agent loop whose context died with its process. */
  async init(): Promise<DreamRecord[]> {
    this.records = await loadDreams(this.home);
    let changed = false;
    for (const r of this.records) {
      if (r.status === "running") {
        r.status = "stopped";
        r.endedAt = r.endedAt ?? Date.now();
        r.summary = r.summary || "interrupted — the process it ran in exited";
        changed = true;
      }
    }
    // Keep ids unique across restarts.
    const maxSeq = this.records.reduce((m, r) => Math.max(m, Number(/^d(\d+)$/.exec(r.id)?.[1] ?? 0)), 0);
    this.seq = maxSeq + 1;
    if (changed) await saveDreams(this.home, this.records);
    return this.records;
  }

  /** Dreams that were interrupted by a restart and could be picked up again. */
  resumable(): DreamRecord[] {
    return this.records.filter((r) => r.status === "stopped" && /interrupted/.test(r.summary));
  }

  list(): DreamRecord[] {
    return [...this.records].sort((a, b) => b.startedAt - a.startedAt);
  }

  active(): DreamRecord[] {
    return this.records.filter((r) => r.status === "running");
  }

  get(id: string): DreamRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  /** Start a dream. Returns its record immediately; the work runs detached. */
  start(task: string, cwd?: string): DreamRecord {
    const engine = this.deps.fork(cwd);
    const id = `d${this.seq++}`;
    const rec: DreamRecord = {
      id,
      task,
      status: "running",
      cwd: engine.cwd,
      model: engine.modelId,
      startedAt: Date.now(),
      endedAt: null,
      usd: 0,
      iterations: 0,
      summary: "",
    };
    this.records.push(rec);
    void saveDreams(this.home, this.records);

    // A dream is not a TUI session: it persists nothing to the session store and
    // never opens an interactive diff prompt.
    engine.interactive = false;
    engine.noPersist = true;
    engine.maxIterations = DREAM_MAX_ITERATIONS;

    let stopped = false;
    const abort = () => {
      if (stopped) return;
      stopped = true;
      try { engine.abort(); } catch { /* already finished */ }
    };

    // The wall-clock cap. unref'd so a sleeping dream can't hold the process open.
    const timer = setTimeout(() => {
      if (rec.status !== "running") return;
      abort();
      void this.finish(id, "capped", "stopped at the 2-hour time limit");
    }, DREAM_MAX_MS);
    if (typeof timer.unref === "function") timer.unref();

    this.live.set(id, { rec, engine, abort, timer });
    this.emit(rec);

    void this.run(id, engine, rec, task).catch((e) => {
      void this.finish(id, "failed", (e as Error).message.slice(0, 200));
    });
    return rec;
  }

  private async run(id: string, engine: Engine, rec: DreamRecord, task: string): Promise<void> {
    const cb = this.callbacks(id, rec);
    await engine.run(DREAM_PREAMBLE + task, cb);
    if (rec.status !== "running") return; // already stopped or capped

    rec.usd = engine.cost.usd;
    const cap = capHit(rec, Date.now());
    const last = [...engine.messages].reverse().find((m) => m.role === "assistant" && !!(m as { text?: string }).text) as { text?: string } | undefined;
    const summary = (last?.text ?? "").trim().split(/\r?\n/)[0]?.slice(0, 160) ?? "";
    await this.finish(id, cap ? "capped" : "done", cap ? `stopped at the ${cap}` : summary || "finished");
  }

  /** The dream's view of the world: approve ordinary calls, stop for dangerous
   *  ones, and never block forever on anything. */
  private callbacks(id: string, rec: DreamRecord): Callbacks {
    const deps = this.deps;
    return {
      onLine: () => {},
      onPending: () => {},
      onAssistant: () => {},
      onToolStart: () => { rec.iterations++; },
      onToolResult: () => {},
      onSystem: () => {},
      onTurnCost: (c) => { rec.usd += c.usd; },
      requestPermission: async (preview: Preview) => {
        // Ordinary calls run unattended — that is the point of a dream. Dangerous
        // ones stop and ask, with a notification, and DENY on timeout: the safe
        // default when nobody is listening is to not do the scary thing.
        if (!preview.dangerous) return "yes";
        notify("Gnosis", `dream ${id} needs approval: ${previewLabel(preview)}`, { enabled: deps.notifyEnabled !== false });
        if (!deps.requestApproval) return "no";
        return withTimeout(
          deps.requestApproval(id, preview),
          deps.approvalTimeoutMs ?? DREAM_APPROVAL_TIMEOUT_MS,
          "no" as PermissionAnswer,
        );
      },
      askUser: async (question, options) => {
        notify("Gnosis", `dream ${id} needs input: ${question.slice(0, 60)}`, { enabled: deps.notifyEnabled !== false });
        if (!deps.askUser) return { text: "", timedOut: true };
        const answer = await withTimeout(
          deps.askUser(id, question, options),
          deps.askTimeoutMs ?? DREAM_ASK_TIMEOUT_MS,
          "",
        );
        // An empty answer means nobody replied in time: the tool turns that into
        // "proceed on your best judgement" rather than stalling the dream.
        return answer ? { text: answer } : { text: "", timedOut: true };
      },
    };
  }

  /** Stop one dream. Safe to call on an already-finished dream. */
  async stop(id: string): Promise<boolean> {
    const l = this.live.get(id);
    if (!l) return false;
    l.abort();
    await this.finish(id, "stopped", "stopped by the user");
    return true;
  }

  /** Stop every running dream. Wired to SIGINT and process exit. */
  stopAll(): void {
    for (const [id, l] of this.live) {
      l.abort();
      if (l.timer) clearTimeout(l.timer);
      const rec = this.records.find((r) => r.id === id);
      if (rec && rec.status === "running") {
        rec.status = "stopped";
        rec.endedAt = Date.now();
        rec.summary = rec.summary || "stopped — the session exited";
      }
    }
    this.live.clear();
    // A parked ask/approval timeout must not keep the process alive after quit.
    clearPendingTimers();
    // Synchronous-best-effort: an exit handler may not get to await.
    void saveDreams(this.home, this.records);
  }

  private async finish(id: string, status: DreamStatus, summary: string): Promise<void> {
    const rec = this.records.find((r) => r.id === id);
    const l = this.live.get(id);
    if (l) {
      if (l.timer) clearTimeout(l.timer);
      rec && (rec.usd = Math.max(rec.usd, l.engine.cost.usd));
      this.live.delete(id);
    }
    if (!rec || rec.status !== "running") return;
    rec.status = status;
    rec.endedAt = Date.now();
    rec.summary = summary;
    await saveDreams(this.home, this.records);
    this.emit(rec);
    const verb = status === "done" ? "finished" : status;
    notify("Gnosis", `dream ${id} ${verb}: ${summary.slice(0, 80)}`, { enabled: this.deps.notifyEnabled !== false });
  }

  private emit(rec: DreamRecord): void {
    try {
      this.deps.bus?.emit({
        type: "dream.state",
        id: rec.id,
        status: rec.status,
        task: rec.task,
        usd: rec.usd,
        summary: rec.summary,
      });
    } catch {
      /* emit and forget */
    }
  }
}

function previewLabel(p: Preview): string {
  if (p.kind === "bash") return p.command;
  if (p.kind === "http") return `${p.method} ${p.url}`;
  if (p.kind === "diff") return p.path;
  return "action";
}

/** Framing the dream's own turn. A dream has nobody to check in with, so it is
 *  told up front to decide and finish rather than stall waiting to be asked. */
const DREAM_PREAMBLE =
  "You are running as a DREAM: a long-horizon task executing in the background with nobody watching. " +
  "Work to completion without checking in. Prefer finishing a smaller, correct slice over leaving a large " +
  "one half-done. Do not ask questions unless a choice would be genuinely unrecoverable. " +
  "End with ONE line summarising what you changed.\n\nTASK: ";

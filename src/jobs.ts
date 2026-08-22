// Background bash jobs. A `run_in_background` bash call hands off to this manager,
// which spawns the process, streams its output into a capped buffer, and returns a
// job id immediately so the turn continues. Jobs are process-global (shared across
// tabs), outlive the turn that launched them, and die with the session — a
// process-exit hook tree-kills anything still running. /jobs, /job, /kill drive it.

import { execa } from "execa";
import { EventEmitter } from "node:events";
import { resolveShell, killTree } from "./tools/bash.js";
import { truncateOutput } from "./tools/truncate.js";
import { snapshotPorts, newPorts } from "./portscan.js";
import type { EventBus } from "./events.js";

export type JobStatus = "running" | "done" | "error" | "killed";

export interface Job {
  id: string;
  command: string;
  /** Name of the tab that launched it (for the completion line); null in single-tab. */
  owner: string | null;
  /** Tab id that launched it, when known — lets the web floor place its figure. */
  ownerTabId: number | null;
  startedAt: number;
  status: JobStatus;
  exitCode: number | null;
  pid?: number;
  /** Port this job started listening on, detected by snapshot-diff; null if none/unknown. */
  port: number | null;
}

interface JobInternal extends Job {
  output: string;
  proc: ReturnType<typeof execa>;
}

const MAX_OUTPUT = 200_000; // keep only the tail of a chatty job

class JobManager extends EventEmitter {
  private jobs = new Map<string, JobInternal>();
  private seq = 0;

  /** Spawn a command in the background. Returns the job (already running). */
  launch(command: string, cwd: string, owner: string | null, ownerTabId: number | null = null): Job {
    const shell = resolveShell();
    const id = String(++this.seq);
    // Snapshot listening ports first so a port this job opens shows up in the diff.
    const portsBefore = snapshotPorts();
    const proc = execa(shell.file, shell.args(command), {
      cwd,
      reject: false,
      all: true,
      buffer: false, // stream into our own buffer instead
      windowsHide: true,
      stripFinalNewline: false,
      detached: process.platform !== "win32", // own process group so killTree takes it
    });
    const job: JobInternal = {
      id,
      command,
      owner,
      ownerTabId,
      startedAt: Date.now(),
      status: "running",
      exitCode: null,
      pid: proc.pid,
      port: null,
      output: "",
      proc,
    };
    this.jobs.set(id, job);
    this.emit("start", this.publicOf(job));

    // A moment after spawn, diff listening ports to attribute a newly-opened one to
    // this job (a dev server). Fire-and-forget; the panel reads job.port when set.
    void this.detectPort(job, portsBefore);

    proc.all?.on("data", (d: Buffer) => {
      job.output += d.toString();
      if (job.output.length > MAX_OUTPUT) job.output = job.output.slice(-MAX_OUTPUT);
    });
    proc
      .then((res) => {
        if (job.status === "killed") return; // already reported by kill()
        job.exitCode = res.exitCode ?? 0;
        job.status = res.exitCode === 0 ? "done" : "error";
        this.emit("done", this.publicOf(job));
      })
      .catch(() => {
        if (job.status === "killed") return;
        job.status = "error";
        this.emit("done", this.publicOf(job));
      });

    return this.publicOf(job);
  }

  private publicOf(j: JobInternal): Job {
    return { id: j.id, command: j.command, owner: j.owner, ownerTabId: j.ownerTabId, startedAt: j.startedAt, status: j.status, exitCode: j.exitCode, pid: j.pid, port: j.port };
  }

  /** Poll for a newly-opened listening port shortly after spawn (dev servers can
   * take a beat to bind). Stops at the first hit, when the job ends, or after ~5s. */
  private async detectPort(job: JobInternal, before: Promise<Set<number>>): Promise<void> {
    const beforeSet = await before;
    for (const delay of [400, 900, 1600, 2500]) {
      if (job.status !== "running" || job.port != null) return;
      await new Promise((r) => setTimeout(r, delay));
      if (job.status !== "running" || job.port != null) return;
      const found = newPorts(beforeSet, await snapshotPorts());
      if (found.length) { job.port = found[0]!; return; }
    }
  }

  list(): Job[] {
    return [...this.jobs.values()].map((j) => this.publicOf(j));
  }
  running(): Job[] {
    return this.list().filter((j) => j.status === "running");
  }
  get(id: string): Job | null {
    const j = this.jobs.get(id);
    return j ? this.publicOf(j) : null;
  }
  /** Output captured so far (tail-capped), or null if there's no such job. */
  output(id: string): string | null {
    const j = this.jobs.get(id);
    if (!j) return null;
    return truncateOutput(j.output || "(no output yet)");
  }
  /** Terminate a job's whole process tree (same path as Ctrl+C). */
  kill(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j) return false;
    if (j.status === "running") {
      j.status = "killed";
      killTree(j.pid);
      this.emit("done", this.publicOf(j));
    }
    return true;
  }
  killAll(): void {
    for (const j of this.jobs.values()) {
      if (j.status === "running") {
        j.status = "killed";
        killTree(j.pid);
      }
    }
  }
}

export const jobs = new JobManager();

// Jobs die with the session: tree-kill any survivors when the process exits.
process.on("exit", () => jobs.killAll());

/**
 * Forward the job manager's lifecycle onto the event bus so `dom serve` browsers
 * see background jobs appear/finish (the Application-zone figure + the background
 * panel). Called by the server when it starts; returns an unsubscribe. Port and
 * live runtime aren't events — the panel reads them from GET /api/jobs.
 */
export function bridgeJobsToBus(bus: EventBus): () => void {
  const onStart = (j: Job) => bus.emit({ type: "job.start", tabId: j.ownerTabId, jobId: j.id, command: j.command });
  const onDone = (j: Job) => bus.emit({ type: "job.end", tabId: j.ownerTabId, jobId: j.id, status: j.status, exitCode: j.exitCode });
  jobs.on("start", onStart);
  jobs.on("done", onDone);
  return () => {
    jobs.off("start", onStart);
    jobs.off("done", onDone);
  };
}

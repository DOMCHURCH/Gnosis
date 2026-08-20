// Background bash jobs. A `run_in_background` bash call hands off to this manager,
// which spawns the process, streams its output into a capped buffer, and returns a
// job id immediately so the turn continues. Jobs are process-global (shared across
// tabs), outlive the turn that launched them, and die with the session — a
// process-exit hook tree-kills anything still running. /jobs, /job, /kill drive it.

import { execa } from "execa";
import { EventEmitter } from "node:events";
import { resolveShell, killTree } from "./tools/bash.js";
import { truncateOutput } from "./tools/truncate.js";

export type JobStatus = "running" | "done" | "error" | "killed";

export interface Job {
  id: string;
  command: string;
  /** Name of the tab that launched it (for the completion line); null in single-tab. */
  owner: string | null;
  startedAt: number;
  status: JobStatus;
  exitCode: number | null;
  pid?: number;
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
  launch(command: string, cwd: string, owner: string | null): Job {
    const shell = resolveShell();
    const id = String(++this.seq);
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
      startedAt: Date.now(),
      status: "running",
      exitCode: null,
      pid: proc.pid,
      output: "",
      proc,
    };
    this.jobs.set(id, job);
    this.emit("start", this.publicOf(job));

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
    return { id: j.id, command: j.command, owner: j.owner, startedAt: j.startedAt, status: j.status, exitCode: j.exitCode, pid: j.pid };
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

import { execa } from "execa";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { truncateOutput } from "./truncate.js";
import { jobs } from "../jobs.js";
import type { BashArgs } from "./schemas.js";
import type { ToolContext, ToolResult } from "./index.js";

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

interface ShellRunner {
  file: string;
  args: (command: string) => string[];
  label: string;
}

function findOnPath(exe: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, exe + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

let cached: ShellRunner | null = null;

/**
 * Resolve the shell. Order (Windows): Git Bash, then bash on PATH, then
 * powershell. Prefer Git Bash — every model emits POSIX commands regardless of
 * the system prompt.
 */
export function resolveShell(): ShellRunner {
  if (cached) return cached;
  if (process.platform === "win32") {
    if (existsSync(GIT_BASH)) {
      cached = { file: GIT_BASH, args: (c) => ["-c", c], label: "git-bash" };
    } else {
      const bash = findOnPath("bash");
      if (bash) {
        cached = { file: bash, args: (c) => ["-c", c], label: "bash" };
      } else {
        cached = {
          file: "powershell",
          args: (c) => ["-NoProfile", "-Command", c],
          label: "powershell",
        };
      }
    }
  } else {
    const bash = findOnPath("bash") ?? "/bin/sh";
    cached = { file: bash, args: (c) => ["-c", c], label: path.basename(bash) };
  }
  return cached;
}

/**
 * Kill a spawned shell AND everything it spawned. `child.kill()` / execa's
 * cancelSignal only reap the direct child (bash.exe), leaving grandchildren
 * (e.g. `sleep`) running. On Windows we taskkill the tree; on POSIX the child
 * is its own process-group leader (detached) so kill(-pid) takes the group.
 */
export function killTree(pid: number | undefined): void {
  if (pid == null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

export async function runBash(args: BashArgs, signal?: AbortSignal, ctx?: ToolContext): Promise<ToolResult> {
  const shell = resolveShell();
  const timeout = (args.timeout ?? 120) * 1000;
  const aborted = (): ToolResult => ({ output: "■ aborted", isError: true, aborted: true });

  // Already cancelled before we even spawn (e.g. Ctrl+C during the prompt).
  if (signal?.aborted) return aborted();

  // Background: hand off to the job manager and return immediately. The job is
  // NOT tied to the turn's AbortSignal — it outlives the turn and dies only with
  // the session or an explicit /kill.
  if (args.run_in_background) {
    const job = jobs.launch(args.command, process.cwd(), ctx?.tab?.selfName() ?? null);
    return {
      output:
        `Started background job ${job.id}: ${args.command}\n` +
        `It runs independently — keep working. Use /job ${job.id} to see output so far, /kill ${job.id} to stop it.`,
      isError: false,
    };
  }

  const child = execa(shell.file, shell.args(args.command), {
    cwd: process.cwd(),
    timeout,
    reject: false,
    all: true,
    windowsHide: true,
    stripFinalNewline: false,
    // execa sends SIGTERM on abort and escalates to SIGKILL after this delay.
    cancelSignal: signal,
    forceKillAfterDelay: 2000,
    // POSIX: give the child its own process group so killTree can take the group.
    detached: process.platform !== "win32",
  });

  // execa's own kill won't reach grandchildren — do a tree kill ourselves.
  const onAbort = () => killTree(child.pid);
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await child;
    if (res.isCanceled || signal?.aborted) return aborted();
    const body = res.all ?? [res.stdout, res.stderr].filter(Boolean).join("\n");
    if (res.timedOut) {
      return {
        output: truncateOutput(`${body}\n\n[command timed out after ${args.timeout ?? 120}s]`),
        isError: true,
      };
    }
    const code = res.exitCode ?? 0;
    const suffix = code === 0 ? "" : `\n[exit code ${code}]`;
    return { output: truncateOutput((body || "(no output)") + suffix), isError: code !== 0 };
  } catch (e) {
    if (signal?.aborted) return aborted();
    return { output: `bash: ${(e as Error).message}`, isError: true };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

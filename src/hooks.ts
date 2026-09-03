// Lifecycle hooks: user scripts in ~/.dom/hooks/ (global) and ./.dom/hooks/
// (project — shadows global per event). Each hook is a file named after the event
// (PreToolUse, PostToolUse, SessionStart, Stop), optionally with an extension that
// selects the interpreter (.mjs/.js → node, .py → python, .ps1 → powershell,
// .sh/none → shell). It receives the event as JSON on stdin.
//
// PreToolUse is the ONLY blocking event: a clean non-zero exit blocks the tool
// call and its stderr becomes the tool error the model sees. A timeout (5s) or a
// crash logs a dim warning and does NOT block. All other events are fire-and-
// forget with the same 5s timeout.

import { execa } from "execa";
import { promises as fs } from "node:fs";
import path from "node:path";
import { domDir } from "./config.js";
import { resolveShell, killTree } from "./tools/bash.js";

export type HookEvent = "SessionStart" | "PreToolUse" | "PostToolUse" | "Stop";
export const HOOK_EVENTS: HookEvent[] = ["SessionStart", "PreToolUse", "PostToolUse", "Stop"];
const TIMEOUT_MS = 5000;

export interface HookRef {
  event: HookEvent;
  path: string;
  scope: "project" | "global";
}

// Project first so it shadows the global hook for the same event.
function hooksDirs(cwd: string): { scope: "project" | "global"; dir: string }[] {
  return [
    { scope: "project", dir: path.join(cwd, ".dom", "hooks") },
    { scope: "global", dir: path.join(domDir(), "hooks") },
  ];
}

async function findInDir(dir: string, event: HookEvent): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  const match = entries.find((f) => f === event || f.startsWith(event + "."));
  return match ? path.join(dir, match) : null;
}

/** Resolve the hook for an event: project shadows global. Null when none. */
export async function resolveHook(cwd: string, event: HookEvent): Promise<HookRef | null> {
  for (const { scope, dir } of hooksDirs(cwd)) {
    const p = await findInDir(dir, event);
    if (p) return { event, path: p, scope };
  }
  return null;
}

/** All registered hooks (one per event, project shadowing global). For /hooks. */
export async function listHooks(cwd: string): Promise<HookRef[]> {
  const out: HookRef[] = [];
  for (const event of HOOK_EVENTS) {
    const h = await resolveHook(cwd, event);
    if (h) out.push(h);
  }
  return out;
}

/** Pick the interpreter for a hook file by extension. */
function commandFor(file: string): { file: string; args: string[] } {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return { file: process.execPath, args: [file] };
  if (ext === ".py") return { file: "python", args: [file] };
  if (ext === ".ps1") return { file: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file] };
  if (ext === ".cmd" || ext === ".bat") return { file, args: [] };
  if (ext === ".sh" || ext === "") {
    if (process.platform === "win32") return { file: resolveShell().file, args: [file] };
    return { file, args: [] };
  }
  return { file, args: [] };
}

interface RunOutcome {
  exitCode: number | null;
  stderr: string;
  timedOut: boolean;
  crashed: boolean;
}

async function runHookProcess(ref: HookRef, payload: unknown, cwd: string): Promise<RunOutcome> {
  const { file, args } = commandFor(ref.path);
  // execa's own `timeout` option only reaps the DIRECT child (the interpreter/
  // shell running the hook) — a hook that backgrounds a subprocess (e.g. a
  // shell hook doing `some-linter & wait`) would leave the grandchild running
  // as an orphan past the 5s cutoff, once per PreToolUse call since it fires
  // on every tool. Cancel via our own AbortSignal instead and tree-kill on
  // it, mirroring tools/bash.ts killTree, which solved the same problem for
  // the bash tool.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const child = execa(file, args, {
      input: JSON.stringify(payload),
      cwd,
      reject: false,
      windowsHide: true,
      cancelSignal: controller.signal,
      forceKillAfterDelay: 2000,
      // POSIX: own process group so killTree(-pid) takes the whole tree.
      detached: process.platform !== "win32",
    });
    controller.signal.addEventListener("abort", () => killTree(child.pid), { once: true });
    const res = await child;
    const timedOut = res.isCanceled === true;
    return { exitCode: res.exitCode ?? 0, stderr: (res.stderr ?? "").trim(), timedOut, crashed: false };
  } catch (e) {
    const timedOut = controller.signal.aborted;
    return { exitCode: null, stderr: ((e as Error).message ?? "").trim(), timedOut, crashed: !timedOut };
  } finally {
    clearTimeout(timer);
  }
}

export interface PreResult {
  block: boolean;
  reason?: string;
  warn?: string;
}

/** PreToolUse — the only blocking hook. A clean non-zero exit blocks (stderr → the
 * model as the tool error); a timeout or crash warns but never blocks. */
export async function runPreToolUse(cwd: string, tool: string, args: unknown): Promise<PreResult> {
  const ref = await resolveHook(cwd, "PreToolUse");
  if (!ref) return { block: false };
  const out = await runHookProcess(ref, { event: "PreToolUse", tool, args, cwd }, cwd);
  if (out.timedOut) return { block: false, warn: `PreToolUse hook timed out (5s) — allowing ${tool}` };
  if (out.crashed) return { block: false, warn: `PreToolUse hook could not run (${out.stderr}) — allowing ${tool}` };
  if ((out.exitCode ?? 0) !== 0) return { block: true, reason: out.stderr || `Blocked by PreToolUse hook (exit ${out.exitCode}).` };
  return { block: false };
}

/** A non-blocking event (PostToolUse / SessionStart / Stop). Returns a dim warning
 * to surface on timeout/crash; never blocks. */
export async function runNonBlockingHook(
  cwd: string,
  event: HookEvent,
  payload: Record<string, unknown>,
): Promise<{ warn?: string }> {
  const ref = await resolveHook(cwd, event);
  if (!ref) return {};
  const out = await runHookProcess(ref, { event, cwd, ...payload }, cwd);
  if (out.timedOut) return { warn: `${event} hook timed out (5s)` };
  if (out.crashed) return { warn: `${event} hook could not run (${out.stderr})` };
  return {};
}

// Permission gating. Three modes: ask (default), plan (reject mutating), yolo.

import { createPatch } from "diff";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Mode } from "./config.js";
import { cacheDir, domDir, skillsDir, worktreesDir } from "./config.js";
import type { ToolDef } from "./tools/index.js";
import { httpBlockReason, normalizeMethod, UNSAFE_METHODS } from "./tools/http.js";
import { normalizeCommand, hasHiddenChars } from "./cmdnorm.js";
import { spawnSync } from "node:child_process";
import { gnosisDir, redirectWrite } from "./workspace.js";
import { scopeDecision, hasProjectContext, type ScopeDecision, writeOpFor, bashScopeViolation, isDeletingCommand, inSandbox, commandPaths } from "./writescope.js";
import { expandHome } from "./homepath.js";

export type PermissionAnswer = "yes" | "no" | "always";

/** One classified line of a unified diff, for coloured rendering. */
export interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk";
  text: string;
}

export type Preview =
  | { kind: "bash"; command: string; dangerous: boolean; cwd: string; warning?: string }
  | { kind: "http"; method: string; url: string; dangerous: boolean; warning?: string }
  | {
      kind: "diff";
      tool: "write" | "edit";
      path: string;
      absPath: string;
      dangerous: boolean;
      warning?: string;
      lines: DiffLine[];
      moreLines: number;
    };

// Commands that ALWAYS prompt, regardless of mode.
const DANGEROUS: RegExp[] = [
  /\brm\s+-\w*r\w*f\w*/i, // rm -rf, -Rf, ...
  /\brm\s+-\w*f\w*r\w*/i, // rm -fr
  /\bgit\s+push\b[^\n]*--force/i,
  /\bdd\b/i,
  /\bmkfs\b/i,
  /\bcurl\b[^|]*\|\s*sh\b/i,
  /\bwget\b[^|]*\|\s*sh\b/i,
  />\s*\/dev\//i,
];

export function isDangerous(command: string): boolean {
  return DANGEROUS.some((re) => re.test(command));
}

// --- dangerous *contexts* (Bug 3) ------------------------------------------
// Some calls are dangerous not because of the command itself but because of
// WHERE they would land: git writes with no surrounding project, anything that
// targets the bare home directory, or anything touching ~/.dom (hard-blocked).

// git subcommands that write to the working tree / repo (init/add/commit/...).
const GIT_WRITE =
  /\bgit\s+(?:-C\s+\S+\s+|-c\s+\S+\s+)*(init|add|commit|rm|mv|apply|restore|reset|checkout|switch|clean|branch|tag|merge|rebase|stash|revert|cherry-pick|am|config|gc)\b/i;

/** The absolute filesystem target a tool call would touch, if it names one.
 * Resolved against the caller's explicit `cwd`, never the global process cwd. */
function resolveTarget(cwd: string, tool: ToolDef, args: any): string | null {
  const raw = args?.path;
  if (typeof raw !== "string" || !raw) return null;
  if (["read", "write", "edit", "glob", "grep", "view_image"].includes(tool.name)) {
    return path.resolve(cwd, expandHome(raw));
  }
  return null;
}

function isInside(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

/**
 * ~/.dom is off-limits to every tool, always — it holds the API key and session
 * data — except for the three carve-outs named below. Returns the offending
 * absolute path (for the message) or null.
 */
export function domTarget(cwd: string, tool: ToolDef, args: any): string | null {
  const dom = domDir();
  // Three pockets of ~/.dom are readable/writable; the rest is off-limits.
  //   skills/    — read on demand
  //   cache/     — skill data indexes (e.g. the public-apis list) tools grep/read
  //   worktrees/ — dom's OWN git worktrees. Anything under here was put there by
  //                createWorktree, so it is dom-managed by construction: the agent
  //                must be able to edit the files it checked out there, and to run
  //                `git worktree remove` / `git branch -D` to clean up afterwards.
  // The API key (config.json), the secrets file (.env), and session history stay
  // blocked — those are what the guard exists for.
  const pockets = [skillsDir(), cacheDir(), worktreesDir()];
  const target = resolveTarget(cwd, tool, args);
  if (target && isInside(target, dom) && !pockets.some((p) => isInside(target, p))) return target;
  if (tool.name === "bash" && bashTouchesBlockedDom(String(args?.command ?? ""))) return dom;
  // A computer-use server publishes dozens of tools with arbitrary argument
  // shapes — a filesystem tool, a script runner, a registry editor — so
  // resolveTarget, which only understands the built-ins' `path`, cannot see where
  // any of them is pointed. Without this, "never touch ~/.dom" would hold for
  // `read` but not for mcp__<server>__filesystem reading the same file. Scan every
  // string argument the same way a raw bash command is scanned: if any of them
  // names a path inside ~/.dom outside the readable pockets, hard-block the call.
  if (tool.computerUse && argStrings(args).some(bashTouchesBlockedDom)) return dom;
  return null;
}

/** Every string anywhere in a tool's arguments (bounded depth, so a pathological
 * payload can't turn the permission gate into a hot loop). */
function argStrings(args: unknown, depth = 0): string[] {
  if (depth > 4 || args == null) return [];
  if (typeof args === "string") return [args];
  if (Array.isArray(args)) return args.flatMap((v) => argStrings(v, depth + 1));
  if (typeof args === "object") return Object.values(args as Record<string, unknown>).flatMap((v) => argStrings(v, depth + 1));
  return [];
}

/**
 * Best-effort check of a raw bash command for a ~/.dom reference that must be
 * blocked. cache/, skills/ and worktrees/ are the readable/writable pockets (a
 * command may freely touch them); everything else under ~/.dom — config.json,
 * .env, sessions/, or the bare directory — stays blocked. We can only inspect
 * the command string, so: find every `.dom` path token and block the command if
 * ANY of them descends anywhere other than those three.
 *
 * This is what lets `git worktree remove ~/.dom/worktrees/<repo>-<name>` and the
 * `git branch -D` that follows it through — without it dom could open worktrees
 * but never tear them down.
 */
function bashTouchesBlockedDom(cmd: string): boolean {
  // Normalize \ to / so absolute (C:\...\.dom\x) and ~/.dom/x forms match alike.
  const norm = cmd.replace(/\\/g, "/");
  const re = /(?:^|[\s"'=/~])\.dom(?=$|[/\s"'])/g;
  for (let m = re.exec(norm); m; m = re.exec(norm)) {
    const rest = norm.slice(m.index + m[0].length); // what follows ".dom", e.g. "/cache/x"
    if (!/^\/(?:cache|skills|worktrees)(?:[/\s"']|$)/.test(rest)) return true; // a blocked .dom path
  }
  return false;
}

/**
 * Reason this call should ALWAYS prompt (regardless of mode / auto-accept), or
 * null when it needs no special treatment. The message names the resolved
 * absolute path so the user can see exactly where it would land.
 */
export function dangerReason(cwd: string, tool: ToolDef, args: any): string | null {
  const home = path.resolve(os.homedir());
  if (tool.name === "bash") {
    const cmd = String(args?.command ?? "");
    const dir = path.resolve(cwd);
    if (GIT_WRITE.test(cmd) && !hasProjectContext(dir)) {
      return `git write command in a directory with no project (no .git or manifest): ${dir}`;
    }
    if (dir === home) return `runs directly in your home directory: ${dir}`;
    return null;
  }
  if (tool.name === "write" || tool.name === "edit") {
    const target = resolveTarget(cwd, tool, args);
    if (target && (target === home || path.dirname(target) === home)) {
      return `writes directly into your home directory: ${target}`;
    }
    return null;
  }
  return null;
}

export function firstToken(command: string): string {
  const m = command.trim().match(/^\S+/);
  return m ? m[0] : command.trim();
}

/** Session-approval key: tool name, plus the command's first token for bash. */
export function approvalKey(tool: ToolDef, args: any): string {
  if (tool.name === "bash") return `bash:${firstToken(String(args.command ?? ""))}`;
  return tool.name;
}

/**
 * Per-target key for counting rejections within a turn: tool name + the concrete
 * thing it would touch (resolved path, http url, or full bash command). Two
 * rejects of the SAME target collide (so we can stop retrying it); a different
 * path — e.g. an "underscore variant" — is a distinct target with its own count.
 */
export function rejectionKey(cwd: string, tool: ToolDef, args: any): string {
  const target = resolveTarget(cwd, tool, args);
  if (target) return `${tool.name}:${target}`;
  if (tool.name === "http") return `http:${String(args?.url ?? "")}`;
  if (tool.name === "bash") return `bash:${String(args?.command ?? "")}`;
  return tool.name;
}

/** Human-readable label for the target of a rejected call (for the model + user). */
export function targetLabel(cwd: string, tool: ToolDef, args: any): string {
  const target = resolveTarget(cwd, tool, args);
  if (target) return path.relative(cwd, target).split(path.sep).join("/") || target;
  if (tool.name === "http") return `${String(args?.method ?? "GET")} ${String(args?.url ?? "")}`;
  if (tool.name === "bash") return String(args?.command ?? "");
  return tool.name;
}

export interface GateContext {
  mode: Mode;
  approvals: Set<string>;
  /** The working directory paths are resolved against (the calling engine's cwd). */
  cwd: string;
}

export type GateDecision =
  | { kind: "allow" }
  | { kind: "reject"; reason: string }
  | {
      kind: "prompt";
      dangerous: boolean;
      reason?: string;
      /**
       * What to do when there is no interactive UI to ask.
       *
       * A dangerous call refuses — that is the point of the flag, and a headless
       * run must not silently do something irreversible. "allow" is for the case
       * where the prompt exists to keep the user INFORMED rather than to stop
       * harm: creating a file outside ~/Gnosis should stop a yolo session so the
       * user sees the path, but refusing it headlessly would mean `dom -p` could
       * never write a file at all. Defaults to refusing.
       */
      nonInteractive?: "allow" | "refuse";
    };

/**
 * Decide what to do with a tool call short of prompting. Returns `prompt` when
 * the UI must ask; the caller builds the appropriate preview and, for file
 * edits, the diff. The caller persists 'always' approvals.
 */
/**
 * Why this call violates the write scope (see writescope.ts), or null.
 *
 * Covers the built-ins by their resolved `path`, bash by scanning its command,
 * and computer-use servers by scanning every string argument — the same three
 * surfaces the ~/.dom guard covers, for the same reason: a filesystem tool from
 * an MCP server can reach the source checkout exactly as `write` can.
 */
export function scopeTarget(cwd: string, tool: ToolDef, args: any): ScopeDecision {
  if (tool.name === "write" || tool.name === "edit") {
    const resolved = resolveTarget(cwd, tool, args);
    if (!resolved) return { kind: "ok" };
    // planWrite redirects a BARE filename into today's ~/Gnosis workspace, so the
    // gate has to judge the same path the bytes will land on — otherwise a bare
    // "notes.md" is rejected here as a create in the cwd while the write tool was
    // going to put it in the sandbox all along.
    const target = (tool.name === "write" ? redirectWrite(cwd, String(args?.path ?? "")) : null) ?? resolved;
    // `edit` never creates, so it is always an edit; `write` depends on whether
    // the file is already there.
    return scopeDecision(tool.name === "edit" ? "edit" : writeOpFor(target), target);
  }
  if (tool.name === "bash") {
    const hit = bashScopeViolation(String(args?.command ?? ""), cwd);
    return hit ? { kind: "reject", reason: hit } : { kind: "ok" };
  }
  if (tool.computerUse) {
    for (const str of argStrings(args)) {
      const hit = bashScopeViolation(str, cwd);
      if (hit) return { kind: "reject", reason: hit };
    }
  }
  return { kind: "ok" };
}

/**
 * A deletion outside the sandbox that the user should look at before it happens.
 * Deleting anywhere but ~/Gnosis is allowed — but it is the one action with no
 * undo, so it always prompts, even in yolo, and the prompt says what is at stake.
 */
function deletionWarning(cwd: string, tool: ToolDef, args: any): string | null {
  if (tool.name !== "bash") return null;
  const cmd = String(args?.command ?? "");
  if (!isDeletingCommand(cmd)) return null;
  const outside = commandPaths(cmd, cwd).filter((p) => !inSandbox(p));
  if (!outside.length) return null; // deleting inside its own folder needs no ceremony
  const tracked = outside.filter((p) => isTrackedFile(p));
  const named = (tracked.length ? tracked : outside).slice(0, 3).map((p) => path.basename(p)).join(", ");
  return tracked.length
    ? `deletes files that are committed to git (${named}) — check this is intended`
    : `deletes files outside ${gnosisDir()} (${named}) — there is no undo`;
}

/** True when git has this file committed — i.e. it is part of a real project and
 *  losing it matters. Best effort: a repo-less or git-less path answers false. */
function isTrackedFile(abs: string): boolean {
  try {
    const dir = path.dirname(abs);
    if (!existsSync(dir)) return false;
    const r = spawnSync("git", ["ls-files", "--error-unmatch", "--", path.basename(abs)], {
      cwd: dir,
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function gate(tool: ToolDef, args: any, ctx: GateContext): GateDecision {
  // Hard block: nothing may touch ~/.dom — not even a read. Never a prompt.
  const dom = domTarget(ctx.cwd, tool, args);
  if (dom) {
    return { kind: "reject", reason: `blocked: ${dom} is inside ~/.dom, which dom must never touch.` };
  }

  // The write scope. Changing the Gnosis source is a flat reject — there is no
  // right answer to "may I modify the program I am running as". Creating a file
  // outside ~/Gnosis is allowed but never silent: it falls through to the
  // dangerous path below, so even yolo stops and shows the user the path.
  const scope = scopeTarget(ctx.cwd, tool, args);
  if (scope.kind === "reject") return { kind: "reject", reason: scope.reason };

  // The http tool has bespoke gating: SSRF/scheme violations are hard rejects
  // (never prompted); unsafe methods (POST/PUT/PATCH/DELETE) always prompt, even
  // in yolo; a GET/HEAD may auto-approve in yolo or via a prior 'always'.
  if (tool.name === "http") {
    const block = httpBlockReason(args);
    if (block) return { kind: "reject", reason: block };
    const method = normalizeMethod(args?.method);
    const unsafe = UNSAFE_METHODS.has(method);
    if (ctx.mode === "plan" && unsafe) {
      return { kind: "reject", reason: "plan mode is active — mutating HTTP methods are disabled." };
    }
    if (unsafe) return { kind: "prompt", dangerous: true, reason: `${method} ${String(args?.url ?? "")}` };
    if (ctx.mode === "yolo") return { kind: "allow" };
    if (ctx.approvals.has(approvalKey(tool, args))) return { kind: "allow" };
    return { kind: "prompt", dangerous: false, reason: `${method} ${String(args?.url ?? "")}` };
  }

  // A call is dangerous if the command matches a dangerous pattern OR it lands
  // in a dangerous place (home dir / non-project git). Dangerous calls always
  // prompt and can never be waved through by yolo, approvals, or auto-accept.
  // Computer use — moving the real mouse, typing on the real keyboard, reading the
  // whole screen — is dangerous by nature, not by argument: there is no safe subset
  // to auto-approve and no undo. Marking it here (rather than as merely `mutating`)
  // is what makes it prompt in yolo mode too, since only `dangerous` survives the
  // yolo/approvals shortcut below.
  // Reasons that mean "a human must actually see this", in precedence order. A
  // scope confirmation is deliberately NOT one of them — it only informs — so it
  // is considered last and never softens a genuine danger that also applies.
  const hardReason =
    (tool.computerUse ? "computer use — controls the real mouse, keyboard, and screen" : null) ??
    deletionWarning(ctx.cwd, tool, args) ??
    dangerReason(ctx.cwd, tool, args) ??
    null;
  const softReason = scope.kind === "confirm" ? scope.reason : null;
  const reason = hardReason ?? softReason ?? undefined;
  const cmd = String(args.command ?? "");
  const dangerous =
    !!tool.computerUse || reason !== undefined || (tool.name === "bash" && (isDangerous(cmd) || hasHiddenChars(cmd)));

  // Read-only tools run free — unless flagged dangerous by context.
  if (!tool.mutating && !dangerous) return { kind: "allow" };

  // plan mode rejects every mutating tool.
  if (ctx.mode === "plan" && tool.mutating) {
    return { kind: "reject", reason: "plan mode is active — mutating tools are disabled." };
  }

  if (!dangerous) {
    if (ctx.mode === "yolo") return { kind: "allow" };
    if (ctx.approvals.has(approvalKey(tool, args))) return { kind: "allow" };
  }

  // A scope confirmation is informational: prompt wherever there is a user, but do
  // not refuse a headless run over it.
  // Soften only when the scope confirmation is the ONLY thing asking. A new file
  // loose in the home directory is both — and must still refuse headlessly.
  return { kind: "prompt", dangerous, reason, ...(!hardReason && softReason ? { nonInteractive: "allow" as const } : {}) };
}

export function buildBashPreview(cwd: string, command: string, warning?: string): Preview {
  // Reveal any hidden characters so the human sees the FULL resolved command.
  const norm = normalizeCommand(command);
  const hiddenWarn = norm.suspicious ? `hidden characters revealed (${norm.reasons.join(", ")})` : undefined;
  const combined = [warning, hiddenWarn].filter(Boolean).join(" · ") || undefined;
  return {
    kind: "bash",
    command: norm.display,
    dangerous: isDangerous(command) || norm.suspicious || warning !== undefined,
    cwd,
    warning: combined,
  };
}

/** Preview for an http request: the method + full URL (with ${VAR} placeholders,
 * never the substituted secret). `dangerous` drives the always-prompt banner. */
export function buildHttpPreview(method: unknown, url: string, dangerous: boolean, warning?: string): Preview {
  return { kind: "http", method: normalizeMethod(method), url, dangerous, warning };
}

/** Keep the prompt readable: cap the rendered diff at ~40 lines. */
const MAX_DIFF_LINES = 40;

/**
 * Compute a unified diff (jsdiff createPatch — no hand-rolled diff math) and
 * classify each line for coloured rendering. For a brand-new file, oldContent
 * is "" so every line is an addition. Truncated past MAX_DIFF_LINES.
 */
export function buildDiffPreview(
  tool: "write" | "edit",
  relPath: string,
  absPath: string,
  oldContent: string,
  newContent: string,
  warning?: string,
): Preview {
  const patch = createPatch(relPath, oldContent, newContent);
  const all: DiffLine[] = [];
  for (const line of patch.split("\n")) {
    if (line === "") continue; // trailing split artifact
    if (line.startsWith("Index:") || line.startsWith("===")) continue; // patch header
    if (line.startsWith("+++") || line.startsWith("---")) continue; // file headers (we show our own)
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("@@")) all.push({ kind: "hunk", text: line });
    else if (line.startsWith("+")) all.push({ kind: "add", text: line });
    else if (line.startsWith("-")) all.push({ kind: "del", text: line });
    else all.push({ kind: "ctx", text: line });
  }
  const lines = all.slice(0, MAX_DIFF_LINES);
  const moreLines = Math.max(0, all.length - MAX_DIFF_LINES);
  return { kind: "diff", tool, path: relPath, absPath, dangerous: warning !== undefined, warning, lines, moreLines };
}

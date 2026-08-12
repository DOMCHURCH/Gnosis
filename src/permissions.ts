// Permission gating. Three modes: ask (default), plan (reject mutating), yolo.

import { createPatch } from "diff";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Mode } from "./config.js";
import { domDir, skillsDir } from "./config.js";
import type { ToolDef } from "./tools/index.js";

export type PermissionAnswer = "yes" | "no" | "always";

/** One classified line of a unified diff, for coloured rendering. */
export interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk";
  text: string;
}

export type Preview =
  | { kind: "bash"; command: string; dangerous: boolean; cwd: string; warning?: string }
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

// A repo is "a project" if it (or an ancestor) has a VCS dir or a build manifest.
const PROJECT_MARKERS = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml"];

// git subcommands that write to the working tree / repo (init/add/commit/...).
const GIT_WRITE =
  /\bgit\s+(?:-C\s+\S+\s+|-c\s+\S+\s+)*(init|add|commit|rm|mv|apply|restore|reset|checkout|switch|clean|branch|tag|merge|rebase|stash|revert|cherry-pick|am|config|gc)\b/i;

/** Walk up from `dir` looking for a .git dir or a build manifest. */
function hasProjectContext(dir: string): boolean {
  let cur = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(cur, ".git"))) return true;
    for (const m of PROJECT_MARKERS) if (existsSync(path.join(cur, m))) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false; // hit the filesystem root
    cur = parent;
  }
}

/** Expand a leading `~` so the .dom hard-block can't be dodged with `~/.dom/...`. */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** The absolute filesystem target a tool call would touch, if it names one. */
function resolveTarget(tool: ToolDef, args: any): string | null {
  const raw = args?.path;
  if (typeof raw !== "string" || !raw) return null;
  if (["read", "write", "edit", "glob", "grep"].includes(tool.name)) {
    return path.resolve(process.cwd(), expandHome(raw));
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
 * data. Returns the offending absolute path (for the message) or null.
 */
export function domTarget(tool: ToolDef, args: any): string | null {
  const dom = domDir();
  // ~/.dom/skills is the one readable/writable pocket of ~/.dom: skills are meant
  // to be read on demand (and managed) via the tools. The API key (config.json)
  // and session history stay blocked.
  const skills = skillsDir();
  const target = resolveTarget(tool, args);
  if (target && isInside(target, dom) && !isInside(target, skills)) return target;
  if (tool.name === "bash") {
    const cmd = String(args?.command ?? "");
    // Best-effort: a shell command that explicitly names the .dom directory.
    if (cmd.includes(dom)) return dom;
    if (/(?:^|[\s"'=/\\~])\.dom(?:$|[/\\\s"'])/.test(cmd)) return dom;
  }
  return null;
}

/**
 * Reason this call should ALWAYS prompt (regardless of mode / auto-accept), or
 * null when it needs no special treatment. The message names the resolved
 * absolute path so the user can see exactly where it would land.
 */
export function dangerReason(tool: ToolDef, args: any): string | null {
  const home = path.resolve(os.homedir());
  if (tool.name === "bash") {
    const cmd = String(args?.command ?? "");
    const cwd = path.resolve(process.cwd());
    if (GIT_WRITE.test(cmd) && !hasProjectContext(cwd)) {
      return `git write command in a directory with no project (no .git or manifest): ${cwd}`;
    }
    if (cwd === home) return `runs directly in your home directory: ${cwd}`;
    return null;
  }
  if (tool.name === "write" || tool.name === "edit") {
    const target = resolveTarget(tool, args);
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

export interface GateContext {
  mode: Mode;
  approvals: Set<string>;
}

export type GateDecision =
  | { kind: "allow" }
  | { kind: "reject"; reason: string }
  | { kind: "prompt"; dangerous: boolean; reason?: string };

/**
 * Decide what to do with a tool call short of prompting. Returns `prompt` when
 * the UI must ask; the caller builds the appropriate preview and, for file
 * edits, the diff. The caller persists 'always' approvals.
 */
export function gate(tool: ToolDef, args: any, ctx: GateContext): GateDecision {
  // Hard block: nothing may touch ~/.dom — not even a read. Never a prompt.
  const dom = domTarget(tool, args);
  if (dom) {
    return { kind: "reject", reason: `blocked: ${dom} is inside ~/.dom, which dom must never touch.` };
  }

  // A call is dangerous if the command matches a dangerous pattern OR it lands
  // in a dangerous place (home dir / non-project git). Dangerous calls always
  // prompt and can never be waved through by yolo, approvals, or auto-accept.
  const reason = dangerReason(tool, args) ?? undefined;
  const dangerous = reason !== undefined || (tool.name === "bash" && isDangerous(String(args.command ?? "")));

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

  return { kind: "prompt", dangerous, reason };
}

export function buildBashPreview(command: string, warning?: string): Preview {
  return {
    kind: "bash",
    command,
    dangerous: isDangerous(command) || warning !== undefined,
    cwd: process.cwd(),
    warning,
  };
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

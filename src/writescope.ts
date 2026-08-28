// Where the agent is allowed to CREATE, CHANGE and DELETE files.
//
// Three rules, in the user's words: don't scatter code files around the computer,
// don't touch your own source, and check what a file is worth before deleting it.
//
//   ~/Gnosis   the sandbox. Create, edit, delete — all fine, it is the agent's own
//              folder and the place new files are supposed to land.
//   ~/dom      the Gnosis source checkout. READ ONLY. No new files, no edits, no
//              deletes. The agent must not modify the program it is running as.
//   a project edit, delete, AND create, freely. Adding a file to a repo the user
//              asked you to work on is the job, and a repo is a legitimate home for
//              a code file. "A project" means a .git dir or a build manifest at or
//              above the path.
//   elsewhere  edit and delete existing files freely, but a NEW file loose on the
//              machine — no repo above it, no project it belongs to — always asks
//              first, even in yolo. That is the case that produces stray files
//              nobody meant to keep. Deleting outside the sandbox asks too: it is
//              the one action with no undo.
//
// Reads are never restricted anywhere.
//
// This sits alongside the ~/.dom guard in permissions.ts rather than replacing it:
// ~/.dom holds credentials and is blocked even for reads, which is a stricter rule
// than anything here.

import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { gnosisDir } from "./workspace.js";

// A directory is "a project" if it, or an ancestor, has a VCS dir or a build
// manifest. Lives here rather than in permissions.ts so the write scope can ask
// the same question the danger check does, without the two drifting apart.
const PROJECT_MARKERS = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml"];

/** Walk up from `dir` looking for a .git dir or a build manifest. */
export function hasProjectContext(dir: string): boolean {
  let cur = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(cur, ".git"))) return true;
    for (const m of PROJECT_MARKERS) if (existsSync(path.join(cur, m))) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false; // hit the filesystem root
    cur = parent;
  }
}

/** The kind of change a call would make. Reads never reach here. */
export type WriteOp = "create" | "edit" | "delete";

/** The Gnosis source checkout — the program's own code, never self-modified. */
export function sourceDir(): string {
  return path.join(os.homedir(), "dom");
}

/** True when `target` is `root` or sits underneath it. */
export function isInside(target: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** True when the path is in the agent's own folder, where everything is allowed. */
export function inSandbox(target: string): boolean {
  return isInside(target, gnosisDir());
}

/** True when the path is in the Gnosis source checkout, which is read-only. */
export function inSource(target: string): boolean {
  return isInside(target, sourceDir());
}

/** What the guard says about an operation. `confirm` means allowed, but never
 *  silently — it always reaches the user, even in yolo. */
export type ScopeDecision = { kind: "ok" } | { kind: "reject"; reason: string } | { kind: "confirm"; reason: string };

const OK: ScopeDecision = { kind: "ok" };

/**
 * What this operation is allowed to do.
 *
 * `target` must already be absolute — resolving it against the right cwd is the
 * caller's job, so the message names the path that would actually be touched.
 *
 * Creating a file in a repo is ordinary work and passes silently. Creating one
 * with no project around it CONFIRMS rather than rejects: the point is that no
 * stray file appears on the machine unseen, which a confirmation achieves, while a
 * refusal would also block legitimate work. Modifying the source is a flat reject:
 * there is no version of that which is correct.
 */
export function scopeDecision(op: WriteOp, target: string): ScopeDecision {
  const abs = path.resolve(target);
  if (inSandbox(abs)) return OK; // the sandbox permits everything, silently
  if (inSource(abs)) {
    return {
      kind: "reject",
      reason:
        `blocked: ${abs} is inside ${sourceDir()} — the Gnosis source code, which is read-only. ` +
        `Read it freely; to change it, ask the user to do it themselves.`,
    };
  }
  if (op === "create") {
    // A new file inside a repo is ordinary work — the user asked for a component,
    // a module, a test — and a repo is where code is supposed to live. Only a file
    // with no project above it is loose, and that is the one worth stopping for.
    if (hasProjectContext(path.dirname(abs))) return OK;
    return {
      kind: "confirm",
      reason: `creates a NEW file with no project around it: ${abs} — loose files belong in ${gnosisDir()}`,
    };
  }
  return OK; // edit / delete of an existing file outside the source: allowed
}

/** The reason an operation is hard-refused, or null. */
export function scopeViolation(op: WriteOp, target: string): string | null {
  const d = scopeDecision(op, target);
  return d.kind === "reject" ? d.reason : null;
}

/**
 * The operation a write actually performs. A "write" to a path that is already
 * there is an edit, not a create — which is what makes "no new files outside the
 * sandbox" a rule about scattering files rather than a ban on editing.
 */
export function writeOpFor(target: string): WriteOp {
  return existsSync(path.resolve(target)) ? "edit" : "create";
}

// --- bash ---------------------------------------------------------------------

/** Commands that change or remove files. Matched on the command string, since a
 *  shell line has no structured arguments to inspect. */
const MUTATING_CMD =
  /(^|[\s;&|(`])(rm|rmdir|unlink|shred|mv|cp|install|truncate|dd|tee|touch|mkdir|chmod|chown|ln)\b|>>?[^&]|\bsed\s+-[a-z]*i|\bgit\s+(checkout|restore|reset|clean|rm|mv|apply|stash|revert)\b|\bnpm\s+(i|install|ci|uninstall)\b/i;

/** Commands whose whole purpose is to delete. These get the extra confirmation. */
const DELETING_CMD = /(^|[\s;&|(`])(rm|rmdir|unlink|shred|del|erase)\b|\bgit\s+clean\b/i;

/** True when the command would change something on disk (best effort). */
export function isMutatingCommand(cmd: string): boolean {
  return MUTATING_CMD.test(cmd);
}

/** True when the command deletes (best effort). */
export function isDeletingCommand(cmd: string): boolean {
  return DELETING_CMD.test(cmd);
}

/**
 * Path-ish tokens in a shell command, resolved against `cwd`.
 *
 * Deliberately generous: this feeds a guard, so over-collecting costs a needless
 * check while under-collecting lets a write through. Backslashes are normalised so
 * a Windows absolute path and a ~/ path are both recognised.
 */
export function commandPaths(cmd: string, cwd: string): string[] {
  const out: string[] = [];
  const home = os.homedir();
  const norm = cmd.replace(/\\/g, "/");
  const re = /(?:[A-Za-z]:)?[~.]?[/\w][\w./~-]*/g;
  for (let m = re.exec(norm); m; m = re.exec(norm)) {
    let tok = m[0];
    if (tok.length < 2 || /^-/.test(tok)) continue;
    if (tok.startsWith("~")) tok = path.join(home, tok.slice(1));
    // A bare word ("index.js") is only a path if it looks like a filename or an
    // existing entry; a flag value or a subcommand is neither.
    const abs = path.isAbsolute(tok) ? tok : path.resolve(cwd, tok);
    out.push(abs);
  }
  return out;
}

/**
 * Why a bash command is refused, or null.
 *
 * Only the source checkout is enforced here. A shell line is not parseable well
 * enough to tell "creates a new file" from "edits one" reliably, so the create
 * rule is enforced where it can be exact — in the write tool — and this catches
 * the rule that must never be wrong: nothing modifies the Gnosis source.
 */
export function bashScopeViolation(cmd: string, cwd: string): string | null {
  if (!isMutatingCommand(cmd)) return null;
  const src = sourceDir();
  for (const p of commandPaths(cmd, cwd)) {
    if (inSandbox(p)) continue;
    if (isInside(p, src)) {
      return (
        `blocked: this command would modify ${p}, inside ${src} — the Gnosis source code, ` +
        `which is read-only. Read it freely; to change it, ask the user to do it themselves.`
      );
    }
  }
  return null;
}

// Where the agent is allowed to CREATE, CHANGE and DELETE files.
//
// Three rules, in the user's words: don't scatter code files around the computer,
// don't touch your own source, and check what a file is worth before deleting it.
//
//   ~/Gnosis   the sandbox. Create, edit, delete — all fine, it is the agent's own
//              folder and the place new files are supposed to land.
//   ~/dom      the Gnosis source checkout. READ ONLY. No new files, no edits, no
//              deletes. The agent must not modify the program it is running as.
//   elsewhere  edit and delete existing files freely (that is the job — working on
//              the user's repos). A NEW file always asks first, even in yolo, so
//              nothing appears anywhere on the machine unseen — which is how
//              race-car.html and smoke.js ended up loose in a repo. Deleting
//              outside the sandbox asks too: it is the one action with no undo.
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
 * Creating outside the sandbox CONFIRMS rather than rejects. A hard refusal also
 * blocks the legitimate case — adding a new file to a project the user asked you
 * to work on — and the goal here is that no file appears anywhere on the machine
 * without the user seeing it, which a confirmation achieves exactly. Modifying the
 * source is a flat reject: there is no version of that which is correct.
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
    return {
      kind: "confirm",
      reason: `creates a NEW file outside ${gnosisDir()}: ${abs} — scratch files belong in ${gnosisDir()}`,
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

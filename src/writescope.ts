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
import { existsSync, realpathSync } from "node:fs";
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

/**
 * Resolve `target` through any symlinks in the portion of the path that
 * already exists on disk, so a symlink planted inside an allowed directory
 * (e.g. materialized by cloning/checking out a repo that commits one) can't
 * redirect a write/edit to a location the containment checks below would
 * otherwise reject. The final, possibly not-yet-created, path segment is
 * appended untouched — a "create" target legitimately doesn't exist yet.
 */
function realish(target: string): string {
  const abs = path.resolve(target);
  let dir = abs;
  const tail: string[] = [];
  while (!existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return abs; // hit the filesystem root, nothing real found
    tail.unshift(path.basename(dir));
    dir = parent;
  }
  try {
    const realDir = realpathSync(dir);
    return tail.length ? path.join(realDir, ...tail) : realDir;
  } catch {
    return abs; // realpath failed (permissions, TOCTOU race) — fall back to the literal path
  }
}

/** True when `target` is `root` or sits underneath it. Both sides are
 *  resolved through symlinks first (see realish) — plain path.resolve
 *  comparison alone can't see a symlink that points outside `root`. */
export function isInside(target: string, root: string): boolean {
  const rel = path.relative(realish(root), realish(target));
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
 * Turn a shell token into a path this process can resolve.
 *
 * On Windows the bash tool resolves to Git Bash, whose absolute paths are MSYS
 * form: `/c/Users/...`, not `C:/Users/...`. Left untranslated, node resolves
 * `/c/Users/Dominique/dom/x` to `C:\c\Users\Dominique\dom\x` — a path under no
 * guarded root at all, so a real write into the source checkout sails straight
 * past the check below. Translate the drive prefix so the guard sees the file the
 * shell would actually open.
 */
export function toNativePath(tok: string): string {
  if (process.platform !== "win32") return tok;
  const m = /^\/([A-Za-z])(\/|$)/.exec(tok);
  const drive = m?.[1];
  return drive ? `${drive.toUpperCase()}:/${tok.slice(3)}` : tok;
}

/** The tokens of a command line that are ARGUMENTS, not the program being run.
 *  A token is in command position at the start of the line and after every
 *  separator. `mkdir` is a program name; resolving it against the cwd is what
 *  blocked every shell command issued from a read-only directory. */
function argumentTokens(norm: string): string[] {
  const args: string[] = [];
  for (const seg of norm.split(/\|\||&&|[;&|(`]|\$\(/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < toks.length && /^\w+=/.test(toks[i] ?? "")) i++; // VAR=x prefixes
    args.push(...toks.slice(i + 1)); // everything after the command name
  }
  return args;
}

/** True when a bare word (no slash, not absolute) is meant as a filename. A
 *  subcommand ("install"), a branch name ("master") or a flag value is not a path;
 *  a name with an extension, or one already on disk, is. */
function bareWordIsPath(tok: string, cwd: string): boolean {
  if (/\.[A-Za-z0-9]{1,8}$/.test(tok)) return true;
  return existsSync(path.resolve(cwd, tok));
}

/**
 * Path-ish tokens in a shell command, resolved against `cwd`.
 *
 * Generous, but not indiscriminate: this feeds a guard, so over-collecting costs a
 * needless check while under-collecting lets a write through — yet collecting
 * every bare word made `mkdir`, `mv` and `cat` look like files in the current
 * directory, which blocked those commands outright wherever the cwd was guarded.
 * Command names are dropped, and a bare word counts only when it looks like a
 * filename or exists on disk. Backslashes are normalised so a Windows absolute
 * path and a ~/ path are both recognised.
 */
export function commandPaths(cmd: string, cwd: string): string[] {
  const out: string[] = [];
  const home = os.homedir();
  const norm = cmd.replace(/\\/g, "/");
  for (const arg of argumentTokens(norm)) {
    // [~.]? previously only ever consumed ONE leading dot, so a token starting
    // with ".." (any relative traversal) lost its first "." entirely before the
    // rest of the token could match — "../dom/x" extracted as "./dom/x",
    // "../../dom/x" as "./../dom/x" (one level too shallow) — silently
    // defeating both source-directory protection and delete-confirmation for
    // ordinary relative paths. (?:~|\.+)? instead consumes a run of dots (or a
    // single ~) as one unit, so a chain of ".." segments round-trips intact.
    const re = /(?:[A-Za-z]:)?(?:~|\.+)?[/\w][\w./~-]*/g;
    for (let m = re.exec(arg); m; m = re.exec(arg)) {
      let tok = m[0];
      if (tok.length < 2 || /^-/.test(tok)) continue;
      if (tok.startsWith("~")) tok = path.join(home, tok.slice(1));
      tok = toNativePath(tok);
      const rooted = path.isAbsolute(tok) || /^[.~]?\//.test(tok);
      if (!rooted && !bareWordIsPath(tok, cwd)) continue;
      out.push(path.isAbsolute(tok) ? tok : path.resolve(cwd, tok));
    }
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

// Auto-commit: after a successful write/edit, commit ONLY that file to the user's
// working branch with a "dom: " message. Silent no-op outside a git repo — never
// runs `git init`, never `git add -A`, and never disturbs the user's other staged
// changes (it commits a single pathspec). /undo reverts the most recent such
// commit. Distinct from checkpoint.ts, which records to a private ref for a
// separate, plumbing-only undo history.

import { execa } from "execa";
import { promises as fs } from "node:fs";
import path from "node:path";

interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const res = await execa("git", args, { cwd, reject: false, windowsHide: true });
    return { ok: res.exitCode === 0, out: res.stdout ?? "", err: res.stderr ?? "" };
  } catch {
    return { ok: false, out: "", err: "" };
  }
}

async function repoRoot(dir: string): Promise<string | null> {
  const r = await git(dir, ["rev-parse", "--show-toplevel"]);
  return r.ok && r.out.trim() ? path.resolve(r.out.trim()) : null;
}

export interface DomCommit {
  sha: string;
  message: string;
  rel: string;
}

/**
 * Commit a single file dom just wrote/edited. Returns the commit or null when it
 * did nothing (not a repo, nothing changed, or no git identity). Never throws.
 */
export async function autoCommitFile(absPath: string, action: "write" | "edit"): Promise<DomCommit | null> {
  try {
    const root = await repoRoot(path.dirname(absPath));
    if (!root) return null; // not a git repo — skip silently, never `git init`
    const realAbs = await fs.realpath(absPath).catch(() => absPath);
    const realRoot = await fs.realpath(root).catch(() => root);
    const rel = path.relative(realRoot, realAbs).split(path.sep).join("/");
    if (!rel || rel.startsWith("..")) return null; // outside the repo

    // Anything to commit for THIS file? (identical-content overwrite → nothing)
    const status = await git(root, ["status", "--porcelain", "--", rel]);
    if (!status.ok || !status.out.trim()) return null;
    const untracked = status.out.trimStart().startsWith("??");

    // Stage only this path, then commit only this pathspec — never `git add -A`,
    // and any other staged changes the user has are left in place.
    await git(root, ["add", "--", rel]);
    const verb = untracked ? "create" : action === "edit" ? "edit" : "update";
    const message = `dom: ${verb} ${rel}`;
    const commit = await git(root, ["commit", "-m", message, "--", rel]);
    if (!commit.ok) return null; // e.g. no configured git identity — skip silently
    const head = await git(root, ["rev-parse", "HEAD"]);
    return { sha: head.out.trim(), message, rel };
  } catch {
    return null;
  }
}

/**
 * Revert the most recent dom auto-commit (subject starts with "dom: ") with a
 * fresh revert commit. Returns what it undid, or null when there's nothing to
 * undo / not a repo / the revert conflicts (left clean).
 */
export async function undoLastDomCommit(cwd: string): Promise<{ message: string; rel: string | null } | null> {
  try {
    const root = await repoRoot(cwd);
    if (!root) return null;
    const log = await git(root, ["log", "-n", "200", "--format=%H%x1f%s"]);
    if (!log.ok) return null;
    let sha: string | null = null;
    let subject = "";
    for (const line of log.out.split("\n")) {
      const [h, s] = line.split("\x1f");
      if (s && s.startsWith("dom: ")) {
        sha = h!;
        subject = s;
        break;
      }
    }
    if (!sha) return null;
    const rev = await git(root, ["revert", "--no-edit", sha]);
    if (!rev.ok) {
      await git(root, ["revert", "--abort"]); // leave the tree clean on conflict
      return null;
    }
    const m = subject.match(/^dom: \w+ (.+)$/);
    return { message: subject, rel: m ? m[1]! : null };
  } catch {
    return null;
  }
}

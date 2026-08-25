// Git worktree isolation. A worktree lets dom work on a task in a *separate*
// checked-out directory on its own branch (`dom/<name>`), so edits there never
// touch the user's current working tree or branch. When the work is good it's
// merged back with `--no-ff` (the isolation stays visible in history); when it's
// not, the whole worktree is thrown away without a trace on the main branch.
//
// Worktrees live under ~/.dom/worktrees/<repo>-<name>. Everything degrades to a
// clear { ok:false, error } rather than throwing, so the UI can just print it.

import { execa } from "execa";
import path from "node:path";
import { promises as fs } from "node:fs";
import { domDir } from "./config.js";

export interface WorktreeInfo {
  /** dom-facing short name (the slug). */
  name: string;
  /** Branch backing the worktree — always `dom/<name>`. */
  branch: string;
  /** Absolute path to the worktree directory. */
  path: string;
}

export type WorktreeResult = { ok: true; info: WorktreeInfo } | { ok: false; error: string };
export type SimpleResult = { ok: true } | { ok: false; error: string };

function git(cwd: string, args: string[]) {
  return execa("git", args, { cwd, reject: false, timeout: 20000 });
}

/** Absolute repo top-level for `cwd`, or null if it isn't inside a git repo. */
export async function repoRoot(cwd: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** Reduce a free-form name to a safe branch/path slug. */
export function slug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || "work"
  );
}

export function worktreesDir(): string {
  return path.join(domDir(), "worktrees");
}

/** Create a worktree on a fresh branch `dom/<name>` off the current HEAD. Fails
 * clearly when `cwd` isn't a repo, the branch already exists, or git refuses. */
export async function createWorktree(cwd: string, rawName: string, prefix = "dom"): Promise<WorktreeResult> {
  const root = await repoRoot(cwd);
  if (!root) return { ok: false, error: "not a git repository — worktrees need git." };
  const name = slug(rawName);
  // `prefix` defaults to "dom" so existing worktrees and their branches keep
  // working; the issue pipeline passes "gnosis" for gnosis/issue-<n>.
  const branch = `${prefix}/${name}`;
  const dir = path.join(worktreesDir(), `${path.basename(root)}-${name}`);

  const exists = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (exists.exitCode === 0) {
    return { ok: false, error: `branch ${branch} already exists — pick another name or /worktree remove ${name}.` };
  }
  await fs.mkdir(worktreesDir(), { recursive: true });
  const r = await git(root, ["worktree", "add", "-b", branch, dir]);
  if (r.exitCode !== 0) {
    return { ok: false, error: (r.stderr || r.stdout || "git worktree add failed").trim() };
  }
  return { ok: true, info: { name, branch, path: dir } };
}

/** List only dom-created worktrees (branch under `dom/`). */
export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  const root = await repoRoot(cwd);
  if (!root) return [];
  const r = await git(root, ["worktree", "list", "--porcelain"]);
  if (r.exitCode !== 0) return [];

  const infos: WorktreeInfo[] = [];
  let cur: { path?: string; branch?: string } = {};
  const flush = () => {
    if (cur.path && cur.branch && cur.branch.startsWith("dom/")) {
      infos.push({ name: cur.branch.slice("dom/".length), branch: cur.branch, path: cur.path });
    }
    cur = {};
  };
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      cur.path = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  flush();
  return infos;
}

/** Remove a dom worktree; optionally delete its branch too. `force` discards
 * uncommitted changes in the worktree. */
export async function removeWorktree(
  cwd: string,
  rawName: string,
  opts: { force?: boolean; deleteBranch?: boolean } = {},
): Promise<SimpleResult> {
  const root = await repoRoot(cwd);
  if (!root) return { ok: false, error: "not a git repository." };
  const name = slug(rawName);
  const wt = (await listWorktrees(root)).find((w) => w.name === name);
  if (!wt) return { ok: false, error: `no dom worktree named ${name}.` };

  const args = ["worktree", "remove", wt.path];
  if (opts.force) args.push("--force");
  const r = await git(root, args);
  if (r.exitCode !== 0) return { ok: false, error: (r.stderr || r.stdout || "git worktree remove failed").trim() };
  if (opts.deleteBranch) await git(root, ["branch", "-D", wt.branch]);
  return { ok: true };
}

/** Merge a worktree's branch into the branch currently checked out in the main
 * repo, `--no-ff` so the merge is a visible unit. On conflict it aborts the merge
 * (leaving the tree clean) and returns the conflict text. */
export async function mergeWorktree(cwd: string, rawName: string): Promise<SimpleResult> {
  const root = await repoRoot(cwd);
  if (!root) return { ok: false, error: "not a git repository." };
  const name = slug(rawName);
  const branch = `dom/${name}`;

  const has = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (has.exitCode !== 0) return { ok: false, error: `no branch ${branch} to merge.` };

  const r = await git(root, ["merge", "--no-ff", "-m", `dom: merge worktree ${name}`, branch]);
  if (r.exitCode !== 0) {
    await git(root, ["merge", "--abort"]); // leave the working tree clean
    return { ok: false, error: (r.stdout || r.stderr || "merge conflict — aborted.").trim() };
  }
  return { ok: true };
}

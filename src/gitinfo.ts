// Small git/gh probes for the status bar and banner. All degrade silently.

import { execa } from "execa";

export interface RepoInfo {
  branch: string | null;
  dirtyCount: number;
}

export async function getRepoInfo(cwd: string): Promise<RepoInfo> {
  try {
    const branchRes = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      reject: false,
      timeout: 3000,
    });
    if (branchRes.exitCode !== 0) return { branch: null, dirtyCount: 0 };
    const branch = branchRes.stdout.trim() || null;
    const statusRes = await execa("git", ["status", "--porcelain"], { cwd, reject: false, timeout: 3000 });
    const dirtyCount = statusRes.stdout.split("\n").filter((l) => l.trim().length > 0).length;
    return { branch, dirtyCount };
  } catch {
    return { branch: null, dirtyCount: 0 };
  }
}

/** Current HEAD sha, or null (not a repo / no commits). */
export async function gitHead(cwd: string): Promise<string | null> {
  try {
    const r = await execa("git", ["rev-parse", "HEAD"], { cwd, reject: false, timeout: 3000 });
    return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** Unified diff of `files` since `baseSha` (committed + working-tree changes). ""
 * when nothing changed, no files, or not a repo. */
export async function gitDiff(cwd: string, baseSha: string | null, files: string[]): Promise<string> {
  if (!files.length) return "";
  try {
    const args = ["--no-pager", "diff"];
    if (baseSha) args.push(baseSha);
    args.push("--", ...files);
    const r = await execa("git", args, { cwd, reject: false, timeout: 10000 });
    return r.exitCode === 0 ? (r.stdout ?? "").trim() : "";
  } catch {
    return "";
  }
}

/** The whole working tree's diff against HEAD (all tracked, staged + unstaged
 * changes). Used by the goal bar to review cumulative work, not just one turn. */
export async function gitDiffHead(cwd: string): Promise<string> {
  try {
    const r = await execa("git", ["--no-pager", "diff", "HEAD"], { cwd, reject: false, timeout: 10000 });
    return r.exitCode === 0 ? (r.stdout ?? "").trim() : "";
  } catch {
    return "";
  }
}

export async function getGhAuth(): Promise<string> {
  try {
    const res = await execa("gh", ["auth", "status"], { reject: false, all: true, timeout: 3000 });
    const text = res.all ?? "";
    if (res.exitCode === 0) {
      const m = text.match(/account\s+(\S+)/i) || text.match(/Logged in to \S+ as (\S+)/i);
      return m ? `signed in (${m[1]})` : "signed in";
    }
    return "not signed in";
  } catch {
    return "gh not installed";
  }
}

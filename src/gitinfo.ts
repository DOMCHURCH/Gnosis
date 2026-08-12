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

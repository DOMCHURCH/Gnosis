// ~/Gnosis — where the agent's own output lives.
//
// Two kinds of file have nowhere good to go. A screenshot is not part of any
// project, and dropping it in the user's repo pollutes their tree. A file written
// with a bare name while the session sits in the home directory has no project to
// belong to either, and lands wherever the shell happened to be.
//
// Both go under ~/Gnosis instead: visible (unlike ~/.dom, which is hidden state
// the agent is blocked from touching), outside every repo, and one place to look.
//
//   ~/Gnosis/
//     screenshots/            all images tools hand back
//     workspace/2026-08-27/   files written without a path, by day

import os from "node:os";
import path from "node:path";

/** The workspace root. */
export function gnosisDir(): string {
  return path.join(os.homedir(), "Gnosis");
}

/** Images returned by tools. Served to the browser only by /api/screenshot —
 * /api/file/raw refuses anything outside the session root, and this is. */
export function screenshotsDir(): string {
  return path.join(gnosisDir(), "screenshots");
}

/** YYYY-MM-DD in local time — the day the user would call it, not UTC's. */
export function dayStamp(at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

/** Today's workspace folder for files written without a path. */
export function workspaceDir(at: Date = new Date()): string {
  return path.join(gnosisDir(), "workspace", dayStamp(at));
}

/**
 * True when `cwd` is somewhere with no project to write into: the home directory
 * itself, or the ~/dom checkout. Matched exactly — a subdirectory (~/dom/src) is
 * a real place to work, and redirecting writes out of it would be surprising.
 */
export function isScratchCwd(cwd: string): boolean {
  const here = path.resolve(cwd);
  return here === path.resolve(os.homedir()) || here === path.resolve(path.join(os.homedir(), "dom"));
}

/**
 * Where a write should actually land, or null to leave it alone.
 *
 * Only a BARE filename is redirected — "notes.md", never "./notes.md",
 * "out/notes.md" or an absolute path. A path with any separator in it is the
 * caller saying where they want it, and that is always honoured; this only
 * catches the case where nobody said, and the session is sitting somewhere with
 * no project to default into.
 */
export function redirectWrite(cwd: string, p: string, at: Date = new Date()): string | null {
  if (!p || p !== path.basename(p) || p.includes("\\") || p.startsWith("~")) return null;
  if (!isScratchCwd(cwd)) return null;
  return path.join(workspaceDir(at), p);
}

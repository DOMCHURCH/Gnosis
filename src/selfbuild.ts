// Self-rebuild on startup when the compiled output is stale. During active
// development the `dom` you run is `dist/`, which silently lags behind edits to
// `src/` and `web/src/`. This compares the newest source mtime against dist/ and,
// when source is newer, runs the build BEFORE the app boots — then re-execs so the
// freshly built code is what actually runs (Node has already loaded the stale dist
// into this process; only a re-exec picks up the new modules).
//
// Everything here is resolved from the INSTALL ROOT (never process.cwd()), so it is
// correct no matter where dom was launched. Set DOM_NO_BUILD to skip the check
// entirely (CI, cron, a known-good global install, or the re-exec'd child).

import { spawnSync } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { INSTALL_ROOT, DIST_DIR, SRC_DIRS } from "./install.js";

/** Newest mtime (ms) of any file under `dir`, recursively. 0 if it doesn't exist. */
export function newestMtime(dir: string): number {
  let newest = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — ignore
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        try {
          const m = statSync(full).mtimeMs;
          if (m > newest) newest = m;
        } catch {
          /* vanished mid-walk — ignore */
        }
      }
    }
  }
  return newest;
}

/** True when a source tree is newer than the compiled output (or dist is missing). */
export function isStale(): boolean {
  if (!existsSync(DIST_DIR)) return true;
  const dist = newestMtime(DIST_DIR);
  const src = Math.max(0, ...SRC_DIRS.map(newestMtime));
  return src > dist;
}

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

/**
 * If the build is stale (and DOM_NO_BUILD isn't set), rebuild and re-exec the same
 * command with the fresh output, then exit. On a build failure we warn and fall
 * through, running the existing (stale) dist rather than blocking the user. The
 * "rebuilding…" notice goes to STDERR so it never pollutes stdout contracts (the
 * `dom serve` URL, `--json` JSONL, `-p` output).
 */
export function maybeRebuild(argv: string[]): void {
  if (process.env.DOM_NO_BUILD) return;
  if (!isStale()) return;

  process.stderr.write(dim("rebuilding…") + "\n");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const build = spawnSync(npm, ["run", "build"], {
    cwd: INSTALL_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    shell: process.platform === "win32", // resolve npm.cmd via the shell on Windows
  });
  if (build.error || build.status !== 0) {
    process.stderr.write(dim("rebuild failed — continuing with the current build") + "\n");
    const detail = (build.stderr || build.error?.message || "").toString().trim();
    if (detail) process.stderr.write(dim(detail.slice(-1500)) + "\n");
    return;
  }

  // Re-exec so the newly built modules are the ones that run. DOM_NO_BUILD guards
  // the child so it can't loop back into another rebuild.
  const res = spawnSync(process.execPath, [path.join(DIST_DIR, "cli.js"), ...argv], {
    stdio: "inherit",
    env: { ...process.env, DOM_NO_BUILD: "1" },
  });
  process.exit(res.status ?? 0);
}

// Is the thing an MCP server needs actually on this machine?
//
// Every server in the default registry is launched as `npx -y <package>`, and
// `npx` ships with Node.js. The desktop app does NOT: Electron embeds a Node
// runtime for its own use, but it does not put `npm`/`npx` on PATH, and a
// freshly-installed Windows machine has no Node at all. So on a clean install
// every default MCP server failed to spawn, and what the user saw was the
// operating system's own message —
//
//   spawn npx ENOENT
//
// — attached to four servers at once, which says nothing about what to do. That
// is the "MCP connections don't work for some reason" report: not a bug in the
// wiring, a missing prerequisite reported in a language nobody can act on.
//
// This resolves the launcher up front so the failure can name itself, and so the
// CONNECTIONS tab can say "install Node.js" instead of repeating ENOENT.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** Cache: this shells out, and the answer cannot change while we are running. */
const cache = new Map<string, boolean>();

/**
 * Can `command` actually be spawned?
 *
 * `where` (Windows) / `which` (POSIX) rather than attempting a spawn, because a
 * real spawn of a package runner may go to the network and take seconds. An
 * absolute path is checked as a path.
 */
export function isRunnable(command: string): boolean {
  const cached = cache.get(command);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    if (path.isAbsolute(command)) {
      // A bare existsSync, not `where`: PATH lookup does not apply to a path the
      // user has already spelled out, and on Windows `where` refuses an absolute
      // argument outright.
      ok = existsSync(command);
    } else {
      const finder = process.platform === "win32" ? "where" : "which";
      const r = spawnSync(finder, [command], { encoding: "utf8", timeout: 5000, windowsHide: true, shell: false });
      ok = r.status === 0 && String(r.stdout ?? "").trim().length > 0;
    }
  } catch {
    ok = false;
  }
  cache.set(command, ok);
  return ok;
}

/**
 * Why this server cannot start, in words the user can act on — or null when its
 * launcher is present and it should simply be connected.
 */
export function launcherProblem(command: string): string | null {
  if (isRunnable(command)) return null;
  // npx/npm are overwhelmingly the case, and they have one fix.
  if (command === "npx" || command === "npm" || command === "node") {
    return (
      `${command} is not installed on this machine, so this server cannot be started. ` +
      "Every MCP server Gnosis ships with runs through npx, which comes with Node.js — " +
      "install the LTS build from https://nodejs.org/en/download and restart Gnosis. " +
      "Nothing else about Gnosis needs it; only MCP servers do."
    );
  }
  if (command === "uvx" || command === "uv") {
    return (
      `${command} is not installed, so this server cannot be started. ` +
      "Install it from https://docs.astral.sh/uv/getting-started/installation/ and restart Gnosis."
    );
  }
  if (command === "python" || command === "python3" || command === "py") {
    return (
      `${command} is not installed, so this server cannot be started. ` +
      "Install Python from https://python.org/downloads (tick “Add python.exe to PATH”) and restart Gnosis."
    );
  }
  return `"${command}" was not found on PATH, so this server cannot be started. Check the command in ~/.dom/mcp.json.`;
}

/** For a one-line startup warning: true when nothing can launch through npx. */
export function nodeMissing(): boolean {
  return !isRunnable("npx");
}

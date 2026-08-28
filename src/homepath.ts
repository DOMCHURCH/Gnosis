import os from "node:os";
import path from "node:path";

/**
 * Expand a leading `~` to the real home directory.
 *
 * `path.resolve` does NOT do this — `~` is shell syntax, not filesystem syntax —
 * so `path.resolve(cwd, "~/Gnosis/x.svg")` yields `<cwd>/~/Gnosis/x.svg`, with a
 * literal `~` directory. On Windows that is the whole bug: nothing else in the
 * stack ever strips it, so the file lands somewhere the user cannot find.
 *
 * This lives in its own module because BOTH sides need it and they must agree.
 * The permission gate resolves a call's target to decide whether it is inside
 * ~/.dom or outside the write scope; the tool then resolves the same argument to
 * decide where the bytes go. If only one of them expands `~`, the user approves
 * one path and the tool touches another.
 *
 * Only a LEADING `~` is expanded, and only when it is the whole path or is
 * followed by a separator: `~/x` and `~` expand, `~foo` (a valid filename, and on
 * POSIX another user's home, which we do not resolve) is left alone.
 */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** `path.resolve` with `~` expanded first — the form every path-taking tool wants. */
export function resolveUserPath(cwd: string, p: string): string {
  return path.resolve(cwd, expandHome(p));
}

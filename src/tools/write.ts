import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { redirectWrite } from "../workspace.js";
import { recordCheckpoint } from "../checkpoint.js";
import { expandHome } from "../homepath.js";
import type { WriteArgs } from "./schemas.js";
import type { ToolContext, ToolResult } from "./index.js";

/** True when `cwd` is the configured Obsidian vault, or a directory inside it. */
function withinVault(cwd: string, vault: string): boolean {
  const rel = path.relative(vault, cwd);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export interface WritePlan {
  relPath: string;
  absPath: string;
  oldContent: string;
  newContent: string;
  existed: boolean;
}

/** Resolve what a write would do (path .md/vault handling + current content),
 * without applying it (drives the diff preview). Paths resolve against `cwd`. */
export async function planWrite(args: WriteArgs, cwd: string = process.cwd()): Promise<WritePlan> {
  // A bare filename written from a directory with no project in it (the home
  // directory, or the ~/dom checkout) has nowhere sensible to land, so it goes to
  // today's ~/Gnosis/workspace folder instead of wherever the shell happened to
  // be. Anything with a separator in it was an explicit choice and is untouched.
  //
  // This happens HERE, in the shared planner, so the permission preview, the diff
  // the user approves, and the bytes on disk are all the same path — a redirect
  // applied later would prompt for one file and write another.
  // `~` is expanded before anything else looks at the path, so the redirect check,
  // the permission preview and the bytes on disk all reason about the same target.
  // Only a path that STARTS with `~` changes here, and such a path always contains
  // a separator (or is bare `~`), so the bare-filename redirect below is untouched.
  const requested = expandHome(args.path);
  const redirected = redirectWrite(cwd, requested);
  let abs = redirected ?? path.resolve(cwd, requested);
  // Vault mode only: a note written without an extension defaults to .md. Outside
  // the configured vault, paths are left exactly as given (no silent .md).
  if (path.extname(abs) === "") {
    const cfg = await loadConfig();
    if (cfg.obsidianVault && withinVault(cwd, path.resolve(cfg.obsidianVault))) {
      abs += ".md";
    }
  }

  let oldContent = "";
  let existed = false;
  try {
    oldContent = await fs.readFile(abs, "utf8");
    existed = true;
  } catch {
    /* new file */
  }

  return {
    // A redirected file is reported by absolute path: "../../Gnosis/workspace/..."
    // relative to a cwd it was deliberately moved out of tells the user nothing.
    relPath: redirected ? abs : path.relative(cwd, abs).split(path.sep).join("/"),
    absPath: abs,
    oldContent,
    newContent: args.content,
    existed,
  };
}

export async function runWrite(args: WriteArgs, _signal?: AbortSignal, ctx?: ToolContext): Promise<ToolResult> {
  const plan = await planWrite(args, ctx?.cwd ?? process.cwd());
  try {
    await fs.mkdir(path.dirname(plan.absPath), { recursive: true });
    await fs.writeFile(plan.absPath, args.content, "utf8");
  } catch (e) {
    return { output: `write: ${(e as Error).message}`, isError: true };
  }

  // Checkpoint the pre-write state (no-op outside git). null = the file was new.
  await recordCheckpoint("write", plan.absPath, plan.existed ? plan.oldContent : null);

  const bytes = Buffer.byteLength(args.content, "utf8");
  const lines = args.content.length ? args.content.split("\n").length : 0;
  return { output: `Wrote ${bytes} bytes (${lines} lines) to ${plan.relPath}`, isError: false };
}

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { recordCheckpoint } from "../checkpoint.js";
import type { WriteArgs } from "./schemas.js";
import type { ToolResult } from "./index.js";

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
 * without applying it (drives the diff preview). */
export async function planWrite(args: WriteArgs): Promise<WritePlan> {
  let abs = path.resolve(process.cwd(), args.path);
  // Vault mode only: a note written without an extension defaults to .md. Outside
  // the configured vault, paths are left exactly as given (no silent .md).
  if (path.extname(abs) === "") {
    const cfg = await loadConfig();
    if (cfg.obsidianVault && withinVault(process.cwd(), path.resolve(cfg.obsidianVault))) {
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
    relPath: path.relative(process.cwd(), abs).split(path.sep).join("/"),
    absPath: abs,
    oldContent,
    newContent: args.content,
    existed,
  };
}

export async function runWrite(args: WriteArgs): Promise<ToolResult> {
  const plan = await planWrite(args);
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

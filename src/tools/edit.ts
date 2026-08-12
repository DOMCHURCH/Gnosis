import { promises as fs } from "node:fs";
import path from "node:path";
import { recordCheckpoint } from "../checkpoint.js";
import type { EditArgs } from "./schemas.js";
import type { ToolResult } from "./index.js";

/** Line numbers (1-based) at which `needle` begins within `text`. */
export function matchLines(text: string, needle: string): number[] {
  const lines: number[] = [];
  if (!needle) return lines;
  let from = 0;
  while (true) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) break;
    lines.push(text.slice(0, idx).split("\n").length);
    from = idx + needle.length;
  }
  return lines;
}

export interface EditPlan {
  relPath: string;
  absPath: string;
  oldContent: string;
  newContent: string;
  replacements: number;
}

/** Resolve what an edit would do, without applying it (drives the diff preview). */
export async function planEdit(args: EditArgs): Promise<EditPlan | { error: string }> {
  const abs = path.resolve(process.cwd(), args.path);
  let text: string;
  try {
    text = await fs.readFile(abs, "utf8");
  } catch (e) {
    return { error: `edit: ${(e as Error).message}` };
  }

  const hits = matchLines(text, args.old_str);
  if (hits.length === 0) {
    return { error: `edit: old_str not found in ${args.path}` };
  }
  if (hits.length > 1 && !args.replace_all) {
    return {
      error:
        `edit: old_str is not unique in ${args.path} — ${hits.length} matches at lines ${hits.join(", ")}. ` +
        `Add surrounding context to old_str until it matches exactly once, or set replace_all: true.`,
    };
  }

  const newContent = args.replace_all
    ? text.split(args.old_str).join(args.new_str)
    : text.replace(args.old_str, args.new_str);

  return {
    relPath: path.relative(process.cwd(), abs).split(path.sep).join("/"),
    absPath: abs,
    oldContent: text,
    newContent,
    replacements: args.replace_all ? hits.length : 1,
  };
}

export async function runEdit(args: EditArgs): Promise<ToolResult> {
  const plan = await planEdit(args);
  if ("error" in plan) return { output: plan.error, isError: true };

  try {
    await fs.writeFile(plan.absPath, plan.newContent, "utf8");
  } catch (e) {
    return { output: `edit: ${(e as Error).message}`, isError: true };
  }

  // Checkpoint the pre-edit content so this change is reversible (no-op outside git).
  await recordCheckpoint("edit", plan.absPath, plan.oldContent);

  const n = plan.replacements;
  return { output: `Edited ${args.path} — ${n} replacement${n === 1 ? "" : "s"}`, isError: false };
}

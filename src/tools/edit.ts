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
  /** How many edit operations were applied (1 for the single-edit form). */
  editCount: number;
}

interface SingleEdit {
  old_str: string;
  new_str: string;
  replace_all?: boolean;
}

/**
 * Reduce either supported form to an ordered list of single edits: the batch
 * `edits` array, or one edit from top-level old_str/new_str. Rejects an ambiguous
 * mix of both, and the empty case.
 */
function normalizeEdits(args: EditArgs): SingleEdit[] | { error: string } {
  const hasBatch = Array.isArray(args.edits) && args.edits.length > 0;
  const hasSingle = args.old_str !== undefined || args.new_str !== undefined;
  if (hasBatch && hasSingle) {
    return { error: "edit: provide EITHER old_str/new_str OR edits, not both." };
  }
  if (hasBatch) {
    return args.edits!.map((e) => ({ old_str: e.old_str, new_str: e.new_str, replace_all: e.replace_all }));
  }
  if (args.old_str === undefined || args.new_str === undefined) {
    return { error: "edit: provide old_str and new_str, or an edits array." };
  }
  return [{ old_str: args.old_str, new_str: args.new_str, replace_all: args.replace_all }];
}

/**
 * Resolve what an edit would do, without applying it (drives the diff preview).
 * Batch edits are applied in memory in order — each edit's uniqueness is checked
 * against the text as left by the previous edits — so a failure anywhere aborts
 * the whole set with nothing written (atomic). The returned newContent already
 * has every edit applied, so the caller's single diff preview is the combined one.
 */
export async function planEdit(args: EditArgs): Promise<EditPlan | { error: string }> {
  const abs = path.resolve(process.cwd(), args.path);
  const edits = normalizeEdits(args);
  if ("error" in edits) return edits;

  let text: string;
  try {
    text = await fs.readFile(abs, "utf8");
  } catch (e) {
    return { error: `edit: ${(e as Error).message}` };
  }

  const original = text;
  const batch = edits.length > 1;
  let replacements = 0;
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]!;
    const where = batch ? ` (edit ${i + 1}/${edits.length})` : "";
    const hits = matchLines(text, e.old_str);
    if (hits.length === 0) {
      return { error: `edit: old_str not found in ${args.path}${where}` };
    }
    if (hits.length > 1 && !e.replace_all) {
      return {
        error:
          `edit: old_str is not unique in ${args.path}${where} — ${hits.length} matches at lines ${hits.join(", ")}. ` +
          `Add surrounding context to old_str until it matches exactly once, or set replace_all: true.`,
      };
    }
    text = e.replace_all ? text.split(e.old_str).join(e.new_str) : text.replace(e.old_str, e.new_str);
    replacements += e.replace_all ? hits.length : 1;
  }

  return {
    relPath: path.relative(process.cwd(), abs).split(path.sep).join("/"),
    absPath: abs,
    oldContent: original,
    newContent: text,
    replacements,
    editCount: edits.length,
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
  const reps = `${n} replacement${n === 1 ? "" : "s"}`;
  const head = plan.editCount > 1 ? `Edited ${args.path} — ${plan.editCount} edits, ${reps}` : `Edited ${args.path} — ${reps}`;
  return { output: head, isError: false };
}

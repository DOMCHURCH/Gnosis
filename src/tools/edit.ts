import { promises as fs } from "node:fs";
import path from "node:path";
import { recordCheckpoint } from "../checkpoint.js";
import type { EditArgs } from "./schemas.js";
import type { ToolContext, ToolResult } from "./index.js";
import { resolveUserPath } from "../homepath.js";

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
export async function planEdit(args: EditArgs, cwd: string = process.cwd()): Promise<EditPlan | { error: string }> {
  const abs = resolveUserPath(cwd, args.path);
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
    relPath: path.relative(cwd, abs).split(path.sep).join("/"),
    absPath: abs,
    oldContent: original,
    newContent: text,
    replacements,
    editCount: edits.length,
  };
}

/** Edits whose new content spans more than this many lines stream progressively
 * (when a stream channel is available); anything smaller writes atomically. */
export const STREAM_MIN_LINES = 10;

/** Abortable delay so streamed lines render progressively instead of in one frame. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

function summarize(args: EditArgs, plan: EditPlan): string {
  const reps = `${plan.replacements} replacement${plan.replacements === 1 ? "" : "s"}`;
  return plan.editCount > 1 ? `Edited ${args.path} — ${plan.editCount} edits, ${reps}` : `Edited ${args.path} — ${reps}`;
}

export async function runEdit(args: EditArgs, signal?: AbortSignal, ctx?: ToolContext): Promise<ToolResult> {
  const plan = await planEdit(args, ctx?.cwd ?? process.cwd());
  if ("error" in plan) return { output: plan.error, isError: true };

  const newLines = plan.newContent.split("\n");
  const stream = ctx?.editStream;
  const shouldStream = !!stream && newLines.length > STREAM_MIN_LINES && plan.newContent !== plan.oldContent;

  if (!shouldStream) {
    // Atomic path: small edits, headless, and sub-agents write in one shot.
    try {
      await fs.writeFile(plan.absPath, plan.newContent, "utf8");
    } catch (e) {
      return { output: `edit: ${(e as Error).message}`, isError: true };
    }
    // Checkpoint the pre-edit content so this change is reversible (no-op outside git).
    await recordCheckpoint("edit", plan.absPath, plan.oldContent);
    return { output: summarize(args, plan), isError: false };
  }

  // Streaming path: emit the new content line by line, then write ONCE at commit.
  // Nothing touches disk until the loop completes without an abort.
  const oldLines = plan.oldContent.split("\n");
  const pace = Math.min(12, Math.floor(900 / newLines.length));
  stream!.start(plan.relPath, plan.oldContent, newLines.length);

  let chars = 0;
  for (let i = 0; i < newLines.length; i++) {
    if (signal?.aborted) {
      stream!.commit(plan.relPath, false, `Edit aborted — ${args.path} left unchanged`);
      return { output: `edit: aborted before write — ${args.path} left unchanged`, isError: true, aborted: true };
    }
    chars += newLines[i]!.length + 1;
    const changed = i >= oldLines.length || newLines[i] !== oldLines[i];
    stream!.line(i, newLines[i]!, changed, chars);
    await sleep(pace, signal);
  }

  // Final abort check: if Ctrl+C landed during the last line's delay, write nothing.
  if (signal?.aborted) {
    stream!.commit(plan.relPath, false, `Edit aborted — ${args.path} left unchanged`);
    return { output: `edit: aborted before write — ${args.path} left unchanged`, isError: true, aborted: true };
  }

  try {
    await fs.writeFile(plan.absPath, plan.newContent, "utf8");
  } catch (e) {
    stream!.commit(plan.relPath, false, `edit failed: ${(e as Error).message}`);
    return { output: `edit: ${(e as Error).message}`, isError: true };
  }
  await recordCheckpoint("edit", plan.absPath, plan.oldContent);
  const head = summarize(args, plan);
  stream!.commit(plan.relPath, true, head);
  return { output: head, isError: false };
}

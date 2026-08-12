// Approval-mode surfaced in the input bar and cycled by shift+tab:
//   normal  -> auto-accept edits -> yolo -> normal
// Maps to the engine's mode ("ask"/"yolo") plus its autoApproveEdits flag.

import type { Mode } from "../config.js";

export type ApprovalMode = "normal" | "auto" | "yolo";

const CYCLE: ApprovalMode[] = ["normal", "auto", "yolo"];

/** Derive the input-bar mode from engine state. plan is handled by the hint. */
export function deriveMode(mode: Mode, autoApproveEdits: boolean): ApprovalMode {
  if (mode === "yolo") return "yolo";
  if (autoApproveEdits) return "auto";
  return "normal";
}

/** shift+tab: return the engine mode + auto flag to apply for the next state. */
export function cycleApprovalMode(
  mode: Mode,
  autoApproveEdits: boolean,
): { mode: Mode; autoApproveEdits: boolean } {
  const next = CYCLE[(CYCLE.indexOf(deriveMode(mode, autoApproveEdits)) + 1) % CYCLE.length]!;
  if (next === "yolo") return { mode: "yolo", autoApproveEdits: false };
  if (next === "auto") return { mode: "ask", autoApproveEdits: true };
  return { mode: "ask", autoApproveEdits: false };
}

/** Dim hint shown under the input bar, reflecting the current mode. */
export function modeHint(mode: Mode, autoApproveEdits: boolean): string {
  if (mode === "plan") return "plan mode · read-only (shift+tab to cycle)";
  if (mode === "yolo") return "yolo on · all tools auto-approved (shift+tab to cycle)";
  if (autoApproveEdits) return "auto-accept edits on (shift+tab to cycle)";
  return "shift+tab to cycle modes";
}

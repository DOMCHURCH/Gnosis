// History compaction. When used tokens exceed 75% of the model's context length,
// summarize the oldest 50% of history into a single note, keep the last 10
// messages verbatim. That 75% reads the SAME used/window ratio the status-bar
// context meter shows, so the bar and compaction never disagree.

import { type Msg, type ToolCall } from "./messages.js";

const KEEP_VERBATIM = 10;

/** Fraction of the context window at which history is compacted. */
export const COMPACT_THRESHOLD = 0.75;

/** `usedTokens` is the engine's single running estimate (contextTokens) — the
 * same numerator the status-bar meter divides by contextLength. */
export function shouldCompact(messages: Msg[], usedTokens: number, contextLength: number): boolean {
  if (!contextLength || messages.length <= KEEP_VERBATIM + 2) return false;
  return usedTokens > contextLength * COMPACT_THRESHOLD;
}

function pathsFromArgs(raw: string): string[] {
  try {
    const o = JSON.parse(raw);
    const p: string[] = [];
    if (typeof o.path === "string") p.push(o.path);
    return p;
  } catch {
    return [];
  }
}

/**
 * Deterministically summarize the oldest 50% of history, preserving the three
 * things that matter across a compaction boundary: file paths touched, decisions
 * (assistant reasoning), and the current objective. Returns the summary text and
 * the trimmed message list. Combine with any prior summary at the call site.
 */
export function compact(messages: Msg[]): { summary: string; kept: Msg[] } {
  const summarizeCount = Math.min(Math.floor(messages.length * 0.5), messages.length - KEEP_VERBATIM);
  if (summarizeCount <= 0) return { summary: "", kept: messages };

  const older = messages.slice(0, summarizeCount);
  const kept = messages.slice(summarizeCount);

  const files = new Set<string>();
  const objectives: string[] = [];
  const decisions: string[] = [];

  for (const m of older) {
    if (m.role === "user") {
      objectives.push(m.text.trim().replace(/\s+/g, " ").slice(0, 200));
    } else if (m.role === "assistant") {
      if (m.text && m.text.trim()) {
        decisions.push(m.text.trim().replace(/\s+/g, " ").slice(0, 200));
      }
      for (const c of m.calls ?? ([] as ToolCall[])) {
        if (c.name === "write" || c.name === "edit" || c.name === "read") {
          for (const p of pathsFromArgs(c.args)) files.add(p);
        }
      }
    }
  }

  const parts: string[] = [];
  if (objectives.length) {
    parts.push(`Objective(s):\n${objectives.slice(-3).map((o) => `- ${o}`).join("\n")}`);
  }
  if (files.size) {
    parts.push(`Files touched:\n${[...files].map((f) => `- ${f}`).join("\n")}`);
  }
  if (decisions.length) {
    parts.push(`Key steps taken:\n${decisions.slice(-8).map((d) => `- ${d}`).join("\n")}`);
  }

  return { summary: parts.join("\n\n"), kept };
}

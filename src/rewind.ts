// Surgical rewind. /compact is blunt — it decides for you what to drop. This lets
// you point at a specific turn and choose what happens to the history around it:
//
//   rewind    — drop everything after that turn. The mistake never happened.
//   summarize — compress everything UP TO that turn into one block and keep
//               everything after verbatim. The early exploration stops costing
//               context, the recent work stays exact.
//
// The two are opposites on purpose: one trims the tail, the other compresses the
// head. Between them you can recover from "I went down the wrong path five turns
// ago" and "the first twenty turns are dead weight" without losing the other end.

import type { Msg } from "./messages.js";

/** One user turn and everything the assistant did in response to it. */
export interface TurnMark {
  /** Index into `messages` of the user message that opened this turn. */
  index: number;
  /** 1-based turn number, oldest first. */
  number: number;
  /** The user's message, trimmed to one line for the picker. */
  summary: string;
  /** Messages belonging to this turn (user + assistant + tool results). */
  length: number;
}

/** Collapse whitespace and cap, so a pasted wall of text stays one picker row. */
function oneLine(text: string, cap = 72): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > cap ? flat.slice(0, cap - 1) + "…" : flat;
}

/**
 * The turn boundaries in a history: one mark per user message, in order. Tool
 * results and assistant replies belong to the turn that precedes them, so a
 * rewind never leaves a dangling tool result whose call has been removed — a
 * history in that shape is rejected by the provider.
 */
export function turnMarks(messages: Msg[]): TurnMark[] {
  const marks: TurnMark[] = [];
  messages.forEach((m, i) => {
    if (m.role !== "user") return;
    marks.push({ index: i, number: marks.length + 1, summary: oneLine(m.text ?? ""), length: 0 });
  });
  marks.forEach((mk, i) => {
    const next = marks[i + 1]?.index ?? messages.length;
    mk.length = next - mk.index;
  });
  return marks;
}

/** The most recent `n` turns, oldest first — what the picker lists. */
export function recentTurns(messages: Msg[], n = 20): TurnMark[] {
  const all = turnMarks(messages);
  return all.slice(Math.max(0, all.length - n));
}

/**
 * Drop this turn and everything after it. The named turn is REMOVED, not kept:
 * "rewind to here" means "put me back to just before I said that", which is what
 * you want when that message is the thing you regret.
 */
export function rewindTo(messages: Msg[], index: number): Msg[] {
  if (index < 0 || index >= messages.length) return messages;
  return messages.slice(0, index);
}

/**
 * Split the history at a turn: everything before it is `head` (to be summarized),
 * everything from it onward is `tail` (kept verbatim). The named turn survives —
 * "summarize up to here" compresses the past and keeps the present.
 */
export function splitForSummary(messages: Msg[], index: number): { head: Msg[]; tail: Msg[] } {
  const at = Math.max(0, Math.min(index, messages.length));
  return { head: messages.slice(0, at), tail: messages.slice(at) };
}

/** The prompt the oracle model answers to produce the compressed block. */
export function summaryPrompt(head: Msg[]): string {
  const transcript = head
    .map((m) => {
      if (m.role === "user") return `USER: ${oneLine(m.text ?? "", 400)}`;
      if (m.role === "assistant") {
        const calls = (m.calls ?? []).map((c) => c.name).join(", ");
        const text = oneLine(m.text ?? "", 400);
        return `ASSISTANT: ${text}${calls ? ` [tools: ${calls}]` : ""}`;
      }
      return `TOOL ${m.name}: ${oneLine(m.result, 200)}${m.isError ? " (error)" : ""}`;
    })
    .join("\n");
  return (
    "Compress the following conversation into a handover note for an agent that will continue the work and will " +
    "NOT see any of it. Preserve exactly four things: (1) the objective, (2) every file path touched and what " +
    "changed in it, (3) decisions made and the reasons behind them, (4) anything already tried that did NOT work, " +
    "so it is not retried. Drop pleasantries, narration, and tool mechanics. Write it as terse notes, not prose.\n\n" +
    transcript
  );
}

/** Wrap the model's summary as the single user message that replaces `head`. */
export function summaryMessage(summary: string, turnsCompressed: number): Msg {
  return {
    role: "user",
    text: `[Summary of the first ${turnsCompressed} turn(s) of this session, compressed to save context]\n\n${summary.trim()}`,
  };
}

/** A rewind/summarize result the caller applies to the engine. */
export interface RewindResult {
  messages: Msg[];
  /** What to tell the user happened. */
  note: string;
}

/** Apply a rewind: drop the named turn and everything after it. */
export function applyRewind(messages: Msg[], mark: TurnMark): RewindResult {
  const kept = rewindTo(messages, mark.index);
  const dropped = messages.length - kept.length;
  return { messages: kept, note: `rewound to before turn ${mark.number} — dropped ${dropped} message(s)` };
}

/** Apply a summarize: replace everything before the named turn with one block. */
export function applySummary(messages: Msg[], mark: TurnMark, summary: string): RewindResult {
  const { head, tail } = splitForSummary(messages, mark.index);
  if (!head.length) return { messages, note: "nothing before that turn to summarize" };
  const turns = turnMarks(head).length;
  return {
    messages: [summaryMessage(summary, turns), ...tail],
    note: `summarized ${turns} turn(s) (${head.length} messages) into one block; everything from turn ${mark.number} kept verbatim`,
  };
}

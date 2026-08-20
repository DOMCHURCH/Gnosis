// Trajectory tracing: append one structured JSONL line per model call, tool call,
// and user turn to ~/.dom/traces/<session>.jsonl. Best-effort — a trace write must
// never break a turn. /trace summarizes the current session's file.

import { promises as fs } from "node:fs";
import path from "node:path";
import { domDir } from "./config.js";

export function tracesDir(): string {
  return path.join(domDir(), "traces");
}
export function traceFile(sessionId: string): string {
  return path.join(tracesDir(), `${sessionId}.jsonl`);
}

export type TraceEvent =
  | { type: "turn"; role: "user"; text: string }
  | { type: "model_call"; model: string; promptTokens: number; completionTokens: number; cachedTokens: number; cost: number; toolCalls: number }
  | { type: "tool_call"; name: string; args: unknown; isError: boolean; outputChars: number };

/** Truncate long string values so a trace line can't balloon (e.g. write content). */
export function truncateDeep(value: unknown, max = 300): unknown {
  if (typeof value === "string") return value.length > max ? value.slice(0, max) + `…(+${value.length - max})` : value;
  if (Array.isArray(value)) return value.map((v) => truncateDeep(v, max));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateDeep(v, max);
    return out;
  }
  return value;
}

/** Append one event (stamped with an ISO time). Never throws. */
export async function appendTrace(sessionId: string, event: TraceEvent, now = new Date().toISOString()): Promise<void> {
  try {
    await fs.mkdir(tracesDir(), { recursive: true });
    await fs.appendFile(traceFile(sessionId), JSON.stringify({ ts: now, ...event }) + "\n", "utf8");
  } catch {
    /* tracing must never break a turn */
  }
}

export async function readTrace(sessionId: string): Promise<TraceEvent[]> {
  let txt: string;
  try {
    txt = await fs.readFile(traceFile(sessionId), "utf8");
  } catch {
    return [];
  }
  const out: TraceEvent[] = [];
  for (const line of txt.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

export interface TraceSummary {
  events: number;
  turns: number;
  modelCalls: number;
  toolCalls: number;
  toolErrors: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
  byTool: Record<string, number>;
  byModel: Record<string, number>;
}

export function summarizeTrace(events: TraceEvent[]): TraceSummary {
  const s: TraceSummary = {
    events: events.length, turns: 0, modelCalls: 0, toolCalls: 0, toolErrors: 0,
    promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, byTool: {}, byModel: {},
  };
  for (const e of events) {
    if (e.type === "turn") s.turns++;
    else if (e.type === "model_call") {
      s.modelCalls++;
      s.promptTokens += e.promptTokens;
      s.completionTokens += e.completionTokens;
      s.cachedTokens += e.cachedTokens;
      s.cost += e.cost;
      s.byModel[e.model] = (s.byModel[e.model] ?? 0) + 1;
    } else if (e.type === "tool_call") {
      s.toolCalls++;
      if (e.isError) s.toolErrors++;
      s.byTool[e.name] = (s.byTool[e.name] ?? 0) + 1;
    }
  }
  return s;
}

/** A compact multi-line summary for the /trace command. */
export function formatTraceSummary(sessionId: string, s: TraceSummary): string {
  const tools = Object.entries(s.byTool).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join(", ") || "none";
  const modelsUsed = Object.entries(s.byModel).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join(", ") || "none";
  const uncached = Math.max(0, s.promptTokens - s.cachedTokens);
  return [
    `trace: ${s.events} events · ${s.turns} turns · ${s.modelCalls} model calls · ${s.toolCalls} tool calls (${s.toolErrors} errored)`,
    `tokens: in ${uncached} + ${s.cachedTokens} cached · out ${s.completionTokens} · $${s.cost.toFixed(4)}`,
    `tools: ${tools}`,
    `models: ${modelsUsed}`,
    `file: ${traceFile(sessionId)}`,
  ].join("\n");
}

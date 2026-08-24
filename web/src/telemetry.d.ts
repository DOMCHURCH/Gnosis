import type { DomEvent } from "./types";

export interface ToolCount { ok: number; fail: number; }
export interface Telemetry {
  tools: Record<string, ToolCount>;
  turns: number;
  tokens: number;
  cachedTokens: number;
  tokensSeries: number[];
  turnStart: number | null;
  ok: number;
  fail: number;
}

export function emptyTelemetry(): Telemetry;
export function foldTelemetry(rec: Telemetry | undefined, event: DomEvent, now: number): Telemetry;
export function toolStats(rec: Telemetry | undefined): { total: number; ok: number; fail: number; successRate: number | null };
export function toolList(rec: Telemetry | undefined): { name: string; ok: number; fail: number; count: number }[];
export function sparkline(series: number[]): string;
export function elapsedLabel(turnStart: number | null, now: number): string;

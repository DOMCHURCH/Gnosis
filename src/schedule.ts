// Scheduled runs: a small registry of prompts to run headlessly on a schedule.
// This module is the PURE core — spec parsing, due-calculation, and the on-disk
// registry (~/.dom/schedules.json). The actual firing (boot + headless turn) and
// the cron/daemon wiring live in scheduler.ts, which calls into here.
//
// Supported specs (case-insensitive, optional leading @):
//   every <n><unit>   n seconds/minutes/hours/days — s|m|h|d or long forms
//   hourly            = every 1h
//   daily <HH:MM>     once a day at local HH:MM (also "daily at HH:MM")

import { promises as fs } from "node:fs";
import path from "node:path";
import { domDir } from "./config.js";

export interface Schedule {
  id: string;
  /** The raw spec string as entered (re-parsed on each tick). */
  spec: string;
  /** The prompt run headlessly when due. */
  prompt: string;
  /** Working directory the run boots in. */
  cwd: string;
  /** Optional model override for the run. */
  model?: string;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastStatus?: "ok" | "error";
}

export type ParsedSpec =
  | { kind: "every"; ms: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "error"; error: string };

const UNIT_MS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
};

export function parseSpec(raw: string): ParsedSpec {
  const s = raw.trim().replace(/^@/, "").toLowerCase();
  if (s === "hourly") return { kind: "every", ms: UNIT_MS.h! };
  if (s === "daily") return { kind: "daily", hour: 9, minute: 0 }; // bare "daily" → 09:00

  const every = /^every\s+(\d+)\s*([a-z]+)$/.exec(s);
  if (every) {
    const n = Number(every[1]);
    const unit = UNIT_MS[every[2]!];
    if (!unit) return { kind: "error", error: `unknown time unit "${every[2]}" (use s/m/h/d).` };
    if (n <= 0) return { kind: "error", error: "interval must be positive." };
    return { kind: "every", ms: n * unit };
  }

  const daily = /^daily(?:\s+at)?\s+(\d{1,2}):(\d{2})$/.exec(s);
  if (daily) {
    const hour = Number(daily[1]);
    const minute = Number(daily[2]);
    if (hour > 23 || minute > 59) return { kind: "error", error: "time out of range (HH:MM, 00:00–23:59)." };
    return { kind: "daily", hour, minute };
  }

  return { kind: "error", error: `unrecognized schedule "${raw}". Try "every 30m", "hourly", or "daily 14:30".` };
}

/** The most recent daily HH:MM slot at or before `now` (local time). */
function lastDailySlot(hour: number, minute: number, now: number): number {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  let t = d.getTime();
  if (t > now) t -= 86_400_000; // today's slot is still in the future → yesterday's
  return t;
}

/** Whether a schedule should fire at `now`, given its lastRunAt. */
export function isDue(schedule: Schedule, now: number): boolean {
  if (!schedule.enabled) return false;
  const parsed = parseSpec(schedule.spec);
  if (parsed.kind === "error") return false;
  if (parsed.kind === "every") {
    const base = schedule.lastRunAt ?? schedule.createdAt;
    return now >= base + parsed.ms;
  }
  // daily: due when the most recent slot is later than the last run (i.e. we
  // haven't run since that slot passed).
  const slot = lastDailySlot(parsed.hour, parsed.minute, now);
  return now >= slot && (schedule.lastRunAt ?? 0) < slot;
}

/** Timestamp of the next run after `from` (for display). null on an invalid spec. */
export function nextRunAt(schedule: Schedule, from: number): number | null {
  const parsed = parseSpec(schedule.spec);
  if (parsed.kind === "error") return null;
  if (parsed.kind === "every") {
    const base = schedule.lastRunAt ?? schedule.createdAt;
    let t = base + parsed.ms;
    while (t <= from) t += parsed.ms; // skip missed intervals to the next future one
    return t;
  }
  const d = new Date(from);
  d.setHours(parsed.hour, parsed.minute, 0, 0);
  let t = d.getTime();
  if (t <= from) t += 86_400_000;
  return t;
}

export function dueSchedules(all: Schedule[], now: number): Schedule[] {
  return all.filter((s) => isDue(s, now));
}

// --- registry (~/.dom/schedules.json) --------------------------------------

export function schedulesPath(): string {
  return path.join(domDir(), "schedules.json");
}

export async function loadSchedules(): Promise<Schedule[]> {
  try {
    const raw = await fs.readFile(schedulesPath(), "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? (data as Schedule[]) : [];
  } catch {
    return [];
  }
}

export async function saveSchedules(schedules: Schedule[]): Promise<void> {
  await fs.mkdir(domDir(), { recursive: true });
  await fs.writeFile(schedulesPath(), JSON.stringify(schedules, null, 2) + "\n", "utf8");
}

/** Add a schedule. `now` and `rand` are injected so callers stay testable; the
 * spec is validated first. Returns the created schedule or an error. */
export async function addSchedule(
  fields: { spec: string; prompt: string; cwd: string; model?: string },
  now: number,
  rand: string,
): Promise<{ ok: true; schedule: Schedule } | { ok: false; error: string }> {
  const parsed = parseSpec(fields.spec);
  if (parsed.kind === "error") return { ok: false, error: parsed.error };
  if (!fields.prompt.trim()) return { ok: false, error: "a schedule needs a prompt." };
  const schedule: Schedule = {
    id: `sch-${now.toString(36)}-${rand}`,
    spec: fields.spec.trim(),
    prompt: fields.prompt.trim(),
    cwd: fields.cwd,
    model: fields.model,
    enabled: true,
    createdAt: now,
  };
  const all = await loadSchedules();
  all.push(schedule);
  await saveSchedules(all);
  return { ok: true, schedule };
}

export async function removeSchedule(id: string): Promise<boolean> {
  const all = await loadSchedules();
  const next = all.filter((s) => s.id !== id);
  if (next.length === all.length) return false;
  await saveSchedules(next);
  return true;
}

/** Record the outcome of a run (updates lastRunAt/lastStatus in place on disk). */
export async function recordRun(id: string, now: number, status: "ok" | "error"): Promise<void> {
  const all = await loadSchedules();
  const s = all.find((x) => x.id === id);
  if (!s) return;
  s.lastRunAt = now;
  s.lastStatus = status;
  await saveSchedules(all);
}

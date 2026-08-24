import type { DomEvent } from "./types";

export type SubtaskStatus = "queued" | "running" | "done" | "failed";
export interface PlanSubtask {
  index: number;
  description: string;
  status: SubtaskStatus;
  startedAt: number | null;
  endedAt: number | null;
}
export interface TaskPlan {
  planId: string;
  subtasks: PlanSubtask[];
}

export function planFromEvent(ev: Extract<DomEvent, { type: "task.plan" }>): TaskPlan;
export function foldPlan(plan: TaskPlan | null, ev: DomEvent, now: number): TaskPlan | null;
export function planStatus(plan: TaskPlan): { queued: number; running: number; done: number; failed: number; total: number; complete: boolean };
export function statusIcon(status: SubtaskStatus): string;
export function statusColor(status: SubtaskStatus): string;
export function subtaskElapsed(st: PlanSubtask, now: number): string;

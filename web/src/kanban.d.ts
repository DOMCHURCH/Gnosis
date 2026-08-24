export type KanbanColumn = "active" | "parked" | "review" | "done";
export const COLUMNS: KanbanColumn[];
export const COLUMN_LABEL: Record<KanbanColumn, string>;
export const COLUMN_COLOR: Record<KanbanColumn, string>;

export function columnFor(agent: { mode?: string } | undefined, override: string | undefined): KanbanColumn;
export function lastAssistant(chatLines: { tabId: number; kind: string; text?: string }[], tabId: number, max?: number): string;
export function boardColumns(state: any, overrides: Record<number, string> | undefined): Record<KanbanColumn, number[]>;

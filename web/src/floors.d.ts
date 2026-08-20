// Types for building.mjs (the runtime is plain JS so it's importable by the Node
// verify suite; these declarations give the TS frontend full typing).

export type FloorName = "Coordinator" | "Planning" | "Coding" | "Application" | "Sub-agents";
export const FLOORS: FloorName[];

export interface AgentState {
  id: number;
  name: string;
  mode: string;
  busy: boolean;
  awaitingPermission: boolean;
  editing: boolean;
  hasJob: boolean;
}

export interface SubAgent {
  parentId: number;
  description: string;
  key: string;
}

export interface MessageLink {
  from: number;
  to: number;
  key: string;
}

export interface BuildingInput {
  order: number[];
  agents: Record<number, AgentState>;
  subagents: SubAgent[];
  links: MessageLink[];
}

export interface Figure {
  id: number | string;
  name: string;
  kind: "agent" | "subagent";
  busy: boolean;
  awaitingPermission?: boolean;
  parentId?: number;
}

export interface Building {
  floors: Record<FloorName, Figure[]>;
  links: MessageLink[];
}

export function floorForAgent(a: Pick<AgentState, "mode" | "editing" | "hasJob">): FloorName;
export function buildingInput(state: {
  order: number[];
  agents: Record<number, { id: number; name: string; mode: string; busy: boolean; awaitingPermission?: boolean }>;
  running?: Record<number, string | null>;
  jobs?: Record<number, string[]>;
  subagents?: SubAgent[];
  links?: MessageLink[];
}): BuildingInput;
export function deriveBuilding(input: BuildingInput): Building;

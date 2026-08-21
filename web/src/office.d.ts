// Types for office.js (plain-JS runtime so the Node verify can import it).
import type { CSSProperties } from "react";

export type ZoneName = "coordinator" | "planning" | "coding" | "application" | "subagents";
export interface Zone { label: string; color: string; slots: [number, number][]; }
export const ZONES: Record<ZoneName, Zone>;
export const STATE_COLOR: Record<string, string>;

export type OfficeState = "busy" | "awaiting" | "speaking" | "idle";

export interface OfficeAgent {
  id: number | string;
  name: string;
  kind: "agent" | "subagent";
  zone: ZoneName;
  state: OfficeState;
  action: string;
  thinking: string[];
  color: string;
  slotX: number;
  slotY: number;
  slotIdx: number;
}

export interface ZoneCount { key: ZoneName; left: string; top: string; text: string; }

export interface OfficeModel {
  placed: OfficeAgent[];
  offFloor: Omit<OfficeAgent, "slotX" | "slotY" | "slotIdx">[];
  freeDesks: { x: number; y: number }[];
  zoneCounts: ZoneCount[];
  awaiting: number;
}

export interface AgentGeom {
  id: number | string;
  name: string;
  color: string;
  opacity: number;
  deskX: number; deskY: number; agX: number; agY: number;
  armAnimL?: CSSProperties; armAnimR?: CSSProperties;
  plateStroke: string;
  labelLeft: string; labelTop: string;
  short: string;
  stateColor: string;
  cueX: number; cueY: number; cueYBig: number;
  isBusy: boolean; isAwait: boolean; isSpeak: boolean;
  selected: boolean; ringX: number; ringY: number;
}

export function zoneForAgent(agent: { mode?: string }, ctx: { ownsSub?: boolean; hasJob?: boolean }): ZoneName;
export function stateForAgent(a: { awaitingPermission?: boolean; busy?: boolean; speaking?: boolean }): OfficeState;
export function officeModel(state: any, debugAgents?: any[]): OfficeModel;
export function agentGeom(a: OfficeAgent, selectedId: number | string | null): AgentGeom;

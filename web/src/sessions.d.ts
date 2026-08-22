// Types for sessions.js (plain-JS runtime so the Node verify can import it).
import type { CSSProperties } from "react";

export type ZoneId = "coordinator" | "planning" | "application" | "coding" | "subagents";
export interface Zone { id: ZoneId; name: string; color: string; x: number; y: number; w: number; d: number; label: [number, number]; slots: [number, number][]; }
export const ZONES: Zone[];
export const ZONE_BY_ID: Record<ZoneId, Zone>;
export const STATE_COLOR: Record<string, string>;
export const pctX: (v: number) => string;
export const pctY: (v: number) => string;

export type FigState = "thinking" | "awaiting" | "speaking" | "idle";
export interface Figure {
  id: string;
  tabId: number;
  kind: "tab" | "job" | "subagent";
  name: string;
  zone: ZoneId;
  state: FigState;
  action: string;
  output: string[];
  thinking: string[];
  color?: string;
}

export interface Placed {
  key: string; id: string; color: string; opacity: number;
  deskX: number; deskY: number; agX: number; agY: number;
  armL?: CSSProperties; armR?: CSSProperties;
  cueX: number; cueY: number; cueYBig: number;
  isThinking: boolean; isAwaiting: boolean; isSpeaking: boolean;
  selected: boolean; ringX: number; ringY: number;
}
export interface ZonePlate { key: string; x: number; y: number; w: number; h: number; fill: string; op: number; }
export interface ZoneLabel { key: string; left: string; top: string; accent: string; name: string; count: string; countColor: string; hint: string; }
export interface NameTag { key: string; left: string; top: string; name: string; stateColor: string; border: string; }
export interface RosterRow { key: string; id: string; name: string; action: string; accent: string; color: string; tag: string; stateColor: string; bg: string; opacity: number; }

export interface FloorLayout {
  zonePlates: ZonePlate[];
  zoneCurbs: ZonePlate[];
  zoneLabels: ZoneLabel[];
  freeDesks: { key: string; x: number; y: number }[];
  placed: Placed[];
  nameTags: NameTag[];
  roster: RosterRow[];
  offFloor: Figure[];
  colorById: Record<string, string>;
}

export interface FloorTab {
  key: number; id: number; num: string; bg: string; fg: string; border: string; accent: string; dot: string; dotAnim?: CSSProperties;
}

export interface SessionsModel {
  floorTabs: FloorTab[];
  activeId: number | null;
  layout: FloorLayout;
  awaitingLine: string;
  globalLine: string;
  costLine: string;
  sessionTitle: string;
  sessionTask: string;
  sessionAccent: string;
  sessionState: string;
  sessionStateColor: string;
  offFloorLine: string;
  offFloorColor: string;
  ctxLine: string;
  chatHeader: string;
}

export function figureState(tab: { awaitingPermission?: boolean; busy?: boolean; speaking?: boolean }): FigState;
export function zoneForTab(tab: { mode?: string }, ctx: { ownsSub?: boolean }): ZoneId;
export function floorFigures(state: any, tabId: number): Figure[];
export function layoutFloor(figures: Figure[], selectedId: string | null, debugFigures?: any[]): FloorLayout;
export function sessionsModel(state: any, activeId: number | null, selectedId: string | null, debugByFloor?: Record<number, any[]>): SessionsModel;

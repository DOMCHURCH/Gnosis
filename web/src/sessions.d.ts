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

/** A decorative, client-only figure the user drops on a specific desk. It has no
 * Engine, no history, and is never sent over the event bus. */
export interface ManualAgent { id: string; name: string; zone: ZoneId; slot: number; state: FigState; }

export type Variant = "A" | "B" | "C";

export interface Placed {
  key: string; id: string; color: string; opacity: number; manual: boolean;
  /** Placement + identity for the 3D floor (officeScene seats by zone/slot). */
  zone: ZoneId; slot: number; name: string; state: FigState;
  /** Colour family: A cyan, B purple/indigo, C green — drives the silhouette tweak. */
  variant: Variant;
  /** SVG transform for the busy 110% scale and VAR-B's extra height (undefined at 1:1). */
  figTransform?: string;
  /** Soft cyan glow while the agent is working. */
  figFilter?: string;
  /** VAR-A: a monitor glow in the agent's colour. */
  deskGlow: boolean;
  /** VAR-C: a second monitor on the desk. */
  deskSecondMonitor: boolean;
  deskX: number; deskY: number; agX: number; agY: number;
  armL?: CSSProperties; armR?: CSSProperties;
  cueX: number; cueY: number; cueYBig: number;
  isThinking: boolean; isAwaiting: boolean; isSpeaking: boolean;
  selected: boolean; ringX: number; ringY: number;
}
export interface ZonePlate { key: string; zone?: ZoneId; collapsed?: boolean; x: number; y: number; w: number; h: number; fill: string; op: number; }
/** One zone's depth shell: ceiling strip + light/dark borders. `dim` scales it for idle zones. */
export interface ZoneDepth { key: string; zone: ZoneId; collapsed: boolean; x: number; y: number; w: number; h: number; dim: number; }
export interface ZoneLabel { key: string; zone: ZoneId; left: string; top: string; accent: string; name: string; count: string; countColor: string; hint: string; }
export interface NameTag { key: string; left: string; top: string; name: string; stateColor: string; border: string; }
export interface RosterRow { key: string; id: string; name: string; action: string; manual: boolean; accent: string; color: string; tag: string; stateColor: string; bg: string; opacity: number; }

export interface FloorLayout {
  zonePlates: ZonePlate[];
  zoneCurbs: ZonePlate[];
  zoneDepth: ZoneDepth[];
  zoneLabels: ZoneLabel[];
  freeDesks: { key: string; x: number; y: number; zone: ZoneId; slot: number }[];
  placed: Placed[];
  nameTags: NameTag[];
  roster: RosterRow[];
  offFloor: Figure[];
  colorById: Record<string, string>;
  takenOverManualIds: string[];
}

export interface FloorTab {
  key: number; id: number; num: string; name: string; label: string; bg: string; fg: string; border: string; accent: string; dot: string; dotAnim?: CSSProperties;
}

export interface SessionsModel {
  floorTabs: FloorTab[];
  activeId: number | null;
  layout: FloorLayout;
  awaitingLine: string;
  globalLine: string;
  costLine: string;
  sessionTitle: string;
  sessionNum: string;
  sessionTask: string;
  sessionAccent: string;
  sessionState: string;
  sessionStateColor: string;
  offFloorLine: string;
  offFloorColor: string;
  ctxLine: string;
  chatHeader: string;
  floorDot: string;
  floorDotPulse: boolean;
  floorCount: string;
  floorCountColor: string;
  floorAwaitingCount: number;
  firstAwaitingId: string | null;
  /** Floor-space x of the first awaiting agent, for scroll-into-view. */
  firstAwaitingX: number | null;
  tokenBar: TokenBar;
}

export interface TokenBar { pct: number; color: string; known: boolean; label: string; }

export interface MinimapCell {
  key: string; zone: ZoneId; label: string;
  x: number; y: number; w: number; h: number;
  color: string; active: boolean;
  /** Centre of the zone in FLOOR coordinates (1440x900), for click-to-centre. */
  cx: number; cy: number;
}

export const MINIMAP_W: number;
export const MINIMAP_H: number;
export const ZONE_DEPTH: { border: number; ceiling: number; lightEdge: string; darkEdge: string; ceilingFill: string; idleOpacity: number };
export function variantOf(color: string): Variant;
export function minimapModel(layout: FloorLayout): MinimapCell[];
export function minimapViewport(scrollLeft: number, clientWidth: number, scrollWidth: number): { x: number; y: number; w: number; h: number } | null;
export function centerScrollLeft(cxFloor: number, clientWidth: number, scrollWidth: number): number;
export function tokenBar(tokens: number, limit: number): TokenBar;

export function figureState(tab: { awaitingPermission?: boolean; busy?: boolean; speaking?: boolean }): FigState;
export function zoneForTab(tab: { mode?: string }, ctx: { ownsSub?: boolean }): ZoneId;
export function floorFigures(state: any, tabId: number): Figure[];
export function layoutFloor(figures: Figure[], selectedId: string | null, debugFigures?: any[], manuals?: ManualAgent[]): FloorLayout;
export function sessionsModel(state: any, activeId: number | null, selectedId: string | null, debugByFloor?: Record<number, any[]>, manuals?: ManualAgent[]): SessionsModel;

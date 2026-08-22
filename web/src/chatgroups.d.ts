import type { RawLine } from "./store";

export interface ChatSegment {
  type: "text" | "code";
  lang?: string;
  text: string;
}

export interface ChatGroup {
  key: string;
  from: string;
  time: string;
  kind: string;
  isApproval: boolean;
  permId?: string;
  segments: ChatSegment[];
}

/** Collapse a tab's raw chat lines into per-speaker, per-turn message blocks. */
export function groupChat(lines: RawLine[]): ChatGroup[];

import type { RawLine } from "./store";

export interface ChatSegment {
  type: "text" | "code";
  lang?: string;
  text: string;
}

export interface ToolPayload {
  tool: string;
  primary: string;
  secondary: string;
  ok: boolean;
  summary: string;
  detail: string;
}

export interface ChatGroup {
  key: string;
  from: string;
  time: string;
  kind: string;
  isApproval: boolean;
  permId?: string;
  /** For kind "approval": the answer once resolved ("yes"|"no"|"always"). */
  resolved?: string;
  /** For kind "tool": the compact call parts + summary + full detail. */
  tool?: ToolPayload;
  segments: ChatSegment[];
}

/** Collapse a tab's raw chat lines into per-speaker, per-turn message blocks. */
export function groupChat(lines: RawLine[]): ChatGroup[];

/** Mark the pending approval `id` resolved and rewrite its text to the outcome. */
export function resolveApproval(lines: RawLine[], id: string, answer: string): RawLine[];

export interface MessageStyle {
  variant: "tool" | "assistant" | "system" | "user" | "approval";
  bg: string;
  borderLeft: string;
  borderRight: string;
  boxed: boolean;
  /** Relative font size in em (1 = the chat rail's base size). */
  fontSize: number;
  color: string;
  centered: boolean;
  /** Full-width tint painted behind the whole message ("" for none). */
  wrapTint: string;
  showMeta: boolean;
}

export const CHAT_HIERARCHY: { toolRule: string; toolBg: string; systemDim: string; userEdge: string; approvalTint: string };
export function messageStyle(kind: string, isApproval?: boolean): MessageStyle;

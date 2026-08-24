// Event + preview shapes mirrored from the server (src/events.ts, src/permissions.ts).
// Kept as a standalone copy so the frontend build doesn't pull in the backend
// module graph; the wire format is the contract between them.

export interface Agent {
  id: number;
  name: string;
  cwd: string;
  model: string;
  mode: string;
  busy: boolean;
  cost: number;
  tokens: number;
  awaitingPermission: boolean;
  /** True when the active model accepts image input (gates the file picker). */
  imageInput: boolean;
  /** True when the active model accepts document (PDF) input. */
  documentInput: boolean;
}

/** A file attachment sent alongside a message (base64 bytes + declared MIME). */
export interface Attachment {
  name: string;
  mime: string;
  /** Base64-encoded bytes (no data: prefix). */
  data: string;
}

/** A live sub-agent figure (subagent.start/end). */
export interface SubAgent {
  parentId: number;
  description: string;
  key: string;
}

/** A transient tab-to-tab message link (message.sent). */
export interface MessageLink {
  from: number;
  to: number;
  key: string;
}

export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "line"; text: string }
  | { kind: "rule"; lang?: string }
  | { kind: "system"; text: string }
  | { kind: "tool"; tool: string; primary: string; secondary: string; ok: boolean; summary: string };

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk";
  text: string;
}

export type Preview =
  | { kind: "bash"; command: string; dangerous: boolean; cwd: string; warning?: string }
  | { kind: "http"; method: string; url: string; dangerous: boolean; warning?: string }
  | { kind: "diff"; tool: "write" | "edit"; path: string; absPath: string; dangerous: boolean; warning?: string; lines: DiffLine[]; moreLines: number };

export interface PermissionRequest {
  tabId: number;
  id: string;
  preview: Preview;
  options: string[];
}

export type DomEvent =
  | { type: "agent.created"; tabId: number; name: string; cwd: string; model: string; mode: string; imageInput: boolean; documentInput: boolean }
  | { type: "agent.closed"; tabId: number; name: string }
  | { type: "agent.mode"; tabId: number; mode: string }
  | { type: "agent.busy"; tabId: number; busy: boolean }
  | { type: "turn.start"; tabId: number }
  | { type: "turn.end"; tabId: number; cost: number; tokens: number; cachedTokens: number }
  | { type: "line"; tabId: number; item: TranscriptItem }
  | { type: "tool.start"; tabId: number; tool: string; args: unknown }
  | { type: "tool.end"; tabId: number; tool: string; primary: string; secondary: string; ok: boolean; summary: string; detail: string }
  | { type: "edit.start"; tabId: number; path: string; original: string; totalLines: number }
  | { type: "edit.line"; tabId: number; index: number; text: string; changed: boolean; chars: number }
  | { type: "edit.commit"; tabId: number; path: string; ok: boolean; summary: string }
  | { type: "subagent.start"; tabId: number; description: string }
  | { type: "subagent.end"; tabId: number; description: string; result: string; ok: boolean }
  | { type: "task.plan"; tabId: number; planId: string; subtasks: { index: number; description: string }[] }
  | { type: "design.shot"; tabId: number; path: string; before: string | null; after: string }
  | { type: "permission.request"; tabId: number; id: string; preview: Preview; options: string[] }
  | { type: "permission.resolved"; tabId: number; id: string; answer: string }
  | { type: "overlay.open"; tabId: number; id: string; kind: string; title: string; items: { value: string; label: string }[]; selected: string | null }
  | { type: "overlay.resolved"; id: string }
  | { type: "job.start"; tabId: number | null; jobId: string; command: string }
  | { type: "job.end"; tabId: number | null; jobId: string; status: string; exitCode: number | null }
  | { type: "message.sent"; from: string; to: string; hops: number }
  | { type: "goal.state"; tabId: number; goal: GoalState | null }
  | { type: "goal.review"; tabId: number; verdict: string; text: string; roundsLeft: number; active: boolean }
  | { type: "vault.changed" }
  | { type: "connections.changed" };

/** The goal bar's per-tab standing goal (mirrors src/engine.ts GoalState). */
export interface GoalState {
  text: string;
  active: boolean;
  roundsLeft: number;
  maxRounds: number;
  reviewModel?: string;
}

/** The latest goal review for a tab (verdict + reviewer feedback). */
export interface GoalReview {
  verdict: string;
  text: string;
  roundsLeft: number;
  active: boolean;
}

export type ClientMessage =
  | { type: "input"; tabId: number; text: string; attachments?: Attachment[] }
  | { type: "command"; tabId: number; command: string }
  | { type: "permission"; id: string; answer: string }
  | { type: "overlay.select"; id: string; value: string }
  | { type: "overlay.cancel"; id: string }
  | { type: "agent.create"; name?: string; purpose?: string }
  | { type: "agent.close"; tabId: number }
  | { type: "job.kill"; jobId: string }
  | { type: "goal.set"; tabId: number; text: string; maxRounds?: number; reviewModel?: string; active?: boolean }
  | { type: "goal.clear"; tabId: number }
  | { type: "vault.save"; reqId: number; filename: string; tags: string[]; content: string }
  | { type: "mcp.toggle"; name: string; enabled: boolean }
  | { type: "memory.clear" };

/** One background job as returned by GET /api/jobs (mirrors src/jobs.ts Job). */
export interface JobInfo {
  id: string;
  command: string;
  owner: string | null;
  ownerTabId: number | null;
  startedAt: number;
  status: "running" | "done" | "error" | "killed";
  exitCode: number | null;
  pid?: number;
  port: number | null;
}

/** One MCP server's state for the CONNECTIONS tab (mirrors src/mcp/manager.ts). */
export interface McpConnection {
  name: string;
  transport: string;
  status: "disabled" | "connecting" | "connected" | "error";
  toolCount: number;
  mutating: boolean;
  disabled: boolean;
  error: string | null;
  description: string;
  tools: { name: string; description: string }[];
}
export interface KeyInfo { name: string; present: boolean; last4: string | null; feature: string }
export interface SkillInfo { name: string; description: string; scope: string }
/** GET /api/connections payload. */
export interface ConnectionsData {
  mcp: McpConnection[];
  keys: KeyInfo[];
  skills: SkillInfo[];
  jobs: JobInfo[];
}

/** GET /api/memory payload — the automatic learned-context summary. */
export interface MemoryData {
  sessions: number;
  topFiles: { path: string; count: number }[];
  decisions: string[];
}

/** A live selection overlay mirrored from the TUI (model/session/file/history). */
export interface OverlayState {
  id: string;
  tabId: number;
  kind: string;
  title: string;
  items: { value: string; label: string }[];
  selected: string | null;
}

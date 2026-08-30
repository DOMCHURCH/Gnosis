// AUTO-GENERATED from src/events.ts — do not edit.
//
// Regenerate with `npm run gen:events` (`npm run build` does it for you).
// The server's union is the source of truth; the only differences are the
// payload types the renderer needs concretely, declared in scripts/gen-events.mjs.
import type { GoalState, Preview, TranscriptItem } from "./types";

export type DomEvent =
  | { type: "agent.created"; tabId: number; name: string; cwd: string; model: string; mode: string; imageInput: boolean; documentInput: boolean; contextLimit: number; contextUsed?: number; tokens?: number; cost?: number }
  | { type: "agent.closed"; tabId: number; name: string }
  | { type: "agent.mode"; tabId: number; mode: string }
  | { type: "agent.busy"; tabId: number; busy: boolean }
  | { type: "turn.start"; tabId: number }
  | { type: "turn.end"; tabId: number; cost: number; tokens: number; cachedTokens: number }
  // Running session totals, emitted after EVERY model call rather than once a turn
  // ends. A turn that fans out to sub-agents runs for minutes, and until this
  // existed the header read "0 tok · $0.0000" for all of it. Absolute, not a delta,
  // so a client that connects mid-turn lands on the right number immediately.
  | { type: "cost.update"; tabId: number; cost: number; tokens: number; cachedTokens: number; contextUsed: number }
  // The automatic outcome evaluation for a file-touching turn. `line` is the dim
  // one-liner already shown in the rail; the rest lets a client offer "fix it".
  | { type: "turn.outcome"; tabId: number; verdict: "pass" | "fail" | "unknown"; confidence: number | null; summary: string; line: string }
  | { type: "line"; tabId: number; item: TranscriptItem }
  | { type: "line.partial"; tabId: number; text: string }
  | { type: "tool.start"; tabId: number; tool: string; args: unknown }
  | { type: "tool.end"; tabId: number; tool: string; primary: string; secondary: string; ok: boolean; summary: string; detail: string }
  // Streaming file edits: a large edit (after approval) writes progressively. The
  // right pane of the diff viewer fills in from edit.line events; edit.commit locks
  // it in. The file is written to disk only at commit, never mid-stream.
  | { type: "edit.start"; tabId: number; path: string; original: string; totalLines: number }
  | { type: "edit.line"; tabId: number; index: number; text: string; changed: boolean; chars: number }
  | { type: "edit.commit"; tabId: number; path: string; ok: boolean; summary: string }
  | { type: "subagent.start"; tabId: number; description: string }
  | { type: "subagent.end"; tabId: number; description: string; result: string; ok: boolean }
  // A coordinated task() announced its plan: one row per subtask, tracked live via
  // the subagent.start/end events that follow (matched by description).
  | { type: "task.plan"; tabId: number; planId: string; subtasks: { index: number; description: string }[] }
  // Design mode: a screenshot of the running dev server. `before` is the prior shot
  // (null for the first), `after` the current one — both base64 PNG data URLs. `path`
  // is the web file whose edit triggered the auto-shot ("" for the initial /design).
  | { type: "design.shot"; tabId: number; path: string; before: string | null; after: string }
  | { type: "permission.request"; tabId: number; id: string; preview: Preview; options: string[] }
  // ask_user: the agent paused mid-turn for a decision only the user can make.
  | { type: "ask.request"; tabId: number; id: string; question: string; options: string[] }
  | { type: "ask.resolved"; tabId: number; id: string; answer: string }
  | { type: "permission.resolved"; tabId: number; id: string; answer: string }
  | { type: "overlay.open"; tabId: number; id: string; kind: string; title: string; items: { value: string; label: string; hint?: string; tier?: string }[]; selected: string | null }
  | { type: "overlay.resolved"; id: string }
  | { type: "job.start"; tabId: number | null; jobId: string; command: string }
  | { type: "job.end"; tabId: number | null; jobId: string; status: string; exitCode: number | null }
  | { type: "message.sent"; from: string; to: string; hops: number }
  | { type: "goal.state"; tabId: number; goal: GoalState | null }
  | { type: "goal.review"; tabId: number; verdict: string; text: string; roundsLeft: number; active: boolean }
  // A secret scan blocked a file's auto-commit.
  | { type: "security.blocked"; tabId: number; path: string; findings: { kind: string; line: number; sample: string }[] }
  // Manual office-floor agents. The model places decorative figures on the web
  // floor ("add 5 agents to the coding floor", "fill the office") via the office
  // tool. They have no Engine and no history, so they ride the bus as a placement
  // REQUEST rather than becoming real tabs: `zone: null` means every zone and
  // `count: null` means fill to capacity — the browser owns the desk layout, so it
  // resolves both against the free desks it actually has.
  | { type: "office.place"; tabId: number; zone: string | null; count: number | null; names: string[]; state: string }
  | { type: "office.clear"; tabId: number }
  // Total wipe of everything a client is drawing: session tabs, transcripts, the
  // chat rail, every figure (real, manual, and sub-agent) and therefore the zone
  // counts. Sent when serve is shutting down, and applied by a client that finds
  // itself talking to a restarted server. `agent.closed` retires ONE agent and
  // leaves that tab's transcript behind for a reconnect to reuse; this retires the
  // whole picture, which is the only correct response to "the session is gone".
  | { type: "floor.reset"; reason: string }
  | { type: "vault.changed" }
  | { type: "connections.changed" }
  // A webhook was captured (POST /webhook/:label) — clients re-read /api/webhooks.
  | { type: "webhook.received"; id: string; label: string; method: string; size: number }
  // The public tunnel URL for `/serve --public` came up (or went away with null).
  | { type: "serve.public"; url: string | null };

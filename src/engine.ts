// The agent engine: UI-agnostic. Drives the stream→tool loop and is wired to
// either the headless runner or the Ink UI via a Callbacks object.

import path from "node:path";
import { promises as fs, existsSync, statSync } from "node:fs";
import { serialize, estimateTokens, type Msg, type ToolCall, type ImagePart, type FilePart } from "./messages.js";
import { withWorkingDir } from "./system-prompt.js";
import { autoCommitFile } from "./autocommit.js";
import { runPreToolUse, runNonBlockingHook } from "./hooks.js";
import { appendTrace, truncateDeep, type TraceEvent } from "./trace.js";
import { gitHead, gitDiff, gitDiffHead } from "./gitinfo.js";
import { redactSecrets } from "./redact.js";
import { streamCompletion, ProviderError, FallbackNeededError, TooLargeError, type ModelInfo, type Usage } from "./provider.js";

/** Pull the human-readable limit phrase out of a 413 error body for the message. */
export function limitPhrase(detail: string): string {
  const m = detail.match(/"message"\s*:\s*"([^"]+)"/);
  const msg = (m ? m[1]! : detail).replace(/\s+/g, " ").trim();
  if (msg.length <= 160) return msg;
  // Truncate near 160, but never mid-number: if a digit run straddles the cut,
  // extend past it so a real cap like "8000" can't be surfaced as "80".
  let end = 160;
  while (end < msg.length && /\d/.test(msg[end]!)) end++;
  return msg.slice(0, end);
}
import { TOOLS, TOOL_NAMES, toolDefinitions, resolveTool, allToolNames, type ToolDef, type ToolResult, type ToolContext, type SubAgentResult, type CoordinatedResult } from "./tools/index.js";
import { toJsonSchema } from "./tools/schemas.js";
import { runBash } from "./tools/bash.js";
import { planWrite } from "./tools/write.js";
import { planEdit } from "./tools/edit.js";
import {
  gate,
  approvalKey,
  rejectionKey,
  targetLabel,
  buildBashPreview,
  buildHttpPreview,
  buildDiffPreview,
  type GateDecision,
  type Preview,
  type PermissionAnswer,
} from "./permissions.js";
import { shouldCompact, compact } from "./compaction.js";
import { MarkdownStripper, type StreamLine } from "./strip.js";
import { createSession, loadConfig, saveSession, type CostState, type Mode, type SessionData, type TodoItem } from "./config.js";
import type { LoadedSkill } from "./skills.js";
import type { EventBus, AppBridge } from "./events.js";

const MAX_ITER = 100;
/** Auto lint/test loop: how many fix retries before giving up and reporting. */
const MAX_FIX_ITERATIONS = 3;

// Plan mode has teeth: these tools are absent from the tool list entirely, so the
// model can't write, run shell commands, hand work to other tabs, or track
// execution — it can only read/search/fetch to research, then produce a written
// plan. Leaves {read, glob, grep, http}.
const PLAN_EXCLUDED = new Set(["write", "edit", "bash", "send_message", "list_tabs", "task", "todo", "view_image", "web_search", "oracle", "memory"]);

// A sub-agent's tools: read-only research only, and no `task` (no recursion).
const SUBAGENT_TOOLS = ["read", "glob", "grep", "http"];

/** Compact one-line rendering of tool args for an MCP permission preview. */
function compactArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args ?? {});
    return s.length > 200 ? s.slice(0, 197) + "…" : s;
  } catch {
    return "{}";
  }
}
const SUBAGENT_MAX_ITER = 15;
const SUBAGENT_TOKEN_BUDGET = 50_000;
// Coordinated sub-agents run many-at-once, so each gets a tighter isolated budget.
const COORD_SUBAGENT_MAX_ITER = 8;
const COORD_SUBAGENT_TOKEN_BUDGET = 15_000;
// The verifier subagent is deliberately blind to the generator's reasoning: it
// sees ONLY the original request and the diff, and judges skeptically. No tools.
const VERIFIER_DIRECTIVE =
  "You are a skeptical code reviewer. You are given a user's ORIGINAL request and the DIFF of changes another agent " +
  "made to satisfy it. You do NOT see that agent's reasoning. Judge ONLY from the request and the diff whether the " +
  "change actually and fully accomplishes the request and is correct. Assume nothing you can't see in the diff. " +
  "Reply on the FIRST line with exactly `PASS` or `FAIL`, then on following lines the specifics: what's missing, " +
  "wrong, risky, or incomplete (for FAIL), or a one-line confirmation (for PASS). Be concise and concrete.";

const SUBAGENT_DIRECTIVE =
  "\n\nYou are a READ-ONLY research sub-agent answering ONE question for another agent. You have only read, glob, " +
  "grep, and http. Work in as FEW tool calls as possible: search once with a good query, read only the files that " +
  "matter, and STOP the moment you can answer — do not keep exploring to be exhaustive, and never burn through your " +
  "tool budget. Then reply with ONLY the answer: a few sentences naming the specific files, lines, or symbols that " +
  "matter. Do NOT narrate your steps, restate the tools you ran, or explain your process — just the finding. Your " +
  "reply is the entire result the caller sees.";

const PLAN_DIRECTIVE =
  "\n\nYou are in PLAN MODE. You have only read-only tools (read, glob, grep, http) — " +
  "write, edit, and bash are unavailable. Research as needed, then produce a clear, concrete written plan of the " +
  "changes you would make (files to touch and what to change in each), and STOP. Do not claim you edited anything. " +
  "The user will run /approve to execute the plan, or /revise to amend it.";

/** The goal bar: a standing goal a tab is being held to. After each file-touching
 * turn a read-only reviewer judges `git diff HEAD` against the goal; a FAIL steers
 * the agent back to work and burns a round. Set from the web UI (per tab). */
export interface GoalState {
  text: string;
  active: boolean;
  /** Correction rounds still available (counts down on each FAIL steer). */
  roundsLeft: number;
  maxRounds: number;
  /** Model id for the reviewer subagent; falls back to config.oracleModel, then
   * the session model. */
  reviewModel?: string;
}

/** The result of one goal review, reported to the UI (and, when `steer` is set,
 * fed back to the agent as the next turn). */
export interface GoalReview {
  verdict: "pass" | "fail" | "unknown";
  text: string;
  roundsLeft: number;
  active: boolean;
  /** Present on a FAIL with rounds remaining: the follow-up turn to inject. */
  steer?: string;
}

/** Tokens + dollars consumed by a single turn (deltas over the turn, sub-agent
 * cost included). */
export interface TurnCost {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  usd: number;
}

export interface Callbacks {
  /** Commit a finalized transcript line as it streams in (the transcript owner). */
  onLine(line: StreamLine): void;
  /** Update the transient in-progress line ("" clears the live region). */
  onPending(text: string): void;
  /** Turn text finished — lines are already committed; msg is recorded in history. */
  onAssistant(msg: Extract<Msg, { role: "assistant" }>): void;
  onToolStart(call: ToolCall, args: unknown): void;
  onToolResult(call: ToolCall, result: ToolResult): void;
  onSystem(text: string): void;
  requestPermission(preview: Preview): Promise<PermissionAnswer>;
  /** Fired once when a turn ends, with that turn's token/dollar cost (optional). */
  onTurnCost?(cost: TurnCost): void;
}

export interface EngineDeps {
  apiKey: string;
  cwd: string;
  systemPrompt: string;
  models: ModelInfo[];
  session: SessionData;
  /** Skills advertised in the system prompt; surfaced verbatim by /skills. */
  skills?: LoadedSkill[];
  /** Model to switch to (for the rest of the session) when the active model 404s
   * or hits an upstream/shared-pool 429 that won't clear on retry. */
  fallbackModel?: string;
  /** Commit every successful write/edit to the repo (default true). */
  autoCommit?: boolean;
  /** Dollar ceiling per session (the base allotment). Default 2. */
  maxSessionUsd?: number;
  /** Extra workspace roots beyond cwd; grep/glob without a path span all of them. */
  workspaceRoots?: string[];
}

export class Engine {
  private apiKey: string;
  /** Working root for this engine (its tab). Every path-resolving tool resolves
   * against this via ctx.cwd — the global process.cwd() is never used or chdir'd.
   * Mutable so /vault can move a single tab's root without touching other tabs. */
  cwd: string;
  private systemPrompt: string;
  models: ModelInfo[];
  private session: SessionData;
  /** Loaded skills (what /skills lists); advertised in the system prompt. */
  readonly skills: LoadedSkill[];

  messages: Msg[];
  modelId: string;
  /** Fallback model for the rest of the session on an unrecoverable model error
   * (404 / upstream-pool 429). Undefined disables fallback. */
  fallbackModel?: string;
  /** Commit each successful write/edit to the repo (session-scoped). */
  autoCommit: boolean;
  /** Base dollar allotment; each "continue" at the ceiling grants another. */
  budgetUsd: number;
  /** Current session cost ceiling (raised on continue); Infinity disables it. */
  budgetCeiling: number;
  mode: Mode;
  summary: string | null;
  cost: CostState;
  /** Workspace roots for multi-root search. roots[0] is always this.cwd (the
   * primary root); grep/glob without an explicit path span every entry. */
  roots: string[];
  /** Event bus + identity for the web view (`dom serve`). Set by the tabs
   * controller; absent in a plain TUI/headless run (then nothing is emitted). */
  bus?: EventBus;
  bridge?: AppBridge;
  agentId = 0;
  agentName = "";
  /** The model's task list (the `todo` tool). Persisted per session; the UI
   * renders it live above the input. Replaced wholesale on each todo call. */
  todos: TodoItem[];
  approvals = new Set<string>();
  /** Set true only by the interactive TUI; enables the file-edit diff prompt. */
  interactive = false;
  /** Session flag: 'always' (or the input-bar auto mode) auto-approves write/edit diffs. */
  autoApproveEdits = false;
  /** Multi-tab runtime access for the send_message/list_tabs tools; set by the
   * tabs controller. Undefined in single-tab/headless — those tools then no-op.
   * Only carries the tab runtime; the tool cwd comes from this.cwd (see toolCtx). */
  toolContext?: Pick<ToolContext, "tab">;

  lastPromptTokens = 0;
  private abortController: AbortController | null = null;
  private repairs = new Map<string, number>();
  /** Per-target rejection counts for the current turn (keyed by rejectionKey). */
  private rejections = new Map<string, number>();
  /** Set to break the tool loop after the current result and hand back to the
   * user (schema-repair limit or repeated rejection of the same target). */
  private stopTurn = false;
  /** Whether this turn already compacted+retried in response to a 413 (too large). */
  private sizeRetried = false;
  /** Files read this session → the file's mtimeMs at read time. Gates edit/overwrite
   * so the model can't edit a file it hasn't seen, or one that changed since it read. */
  private readFiles = new Map<string, number>();
  /** When set, restricts the advertised/allowed tools to exactly this list (used by
   * sub-agents to enforce a read-only set). Overrides mode-based filtering. */
  toolAllowList?: string[];
  /** Per-turn caps (sub-agents lower these); parents keep the generous defaults. */
  maxIterations = MAX_ITER;
  tokenBudget = Infinity;
  /** Why the last run stopped early ("iteration"/"token"), or null. */
  capped: string | null = null;
  /** Ephemeral sessions (sub-agents, `-p` pipe mode without --save) aren't
   * written to ~/.dom/sessions. */
  noPersist = false;
  /** True for a spawned sub-agent engine. Sub-agents get no `coordinate` runner,
   * which enforces "sub-agents cannot spawn further (coordinated) sub-agents". */
  isSubAgent = false;
  /** Images attached to the NEXT user turn (an @image in TUI input). Consumed and
   * cleared when run() pushes the user message. */
  private nextUserImages: ImagePart[] = [];
  /** Documents (PDFs) attached to the NEXT user turn (web upload). Consumed and
   * cleared when run() pushes the user message. */
  private nextUserFiles: FilePart[] = [];
  /** A write/edit succeeded this turn — arms the auto lint/test loop at turn end. */
  private editedThisTurn = false;
  /** Files edited this turn (absolute) + the base commit before them, for the
   * verifier's diff. turnRequest is the user text that started the turn. */
  private turnEditedFiles = new Set<string>();
  private turnBaseSha: string | null | undefined = undefined;
  private turnRequest = "";
  /** The goal bar state for this tab (null = no goal). Set from the web UI. */
  goal: GoalState | null = null;
  /** Fix retries used by the auto lint/test loop this turn (cap MAX_FIX_ITERATIONS). */
  private fixIterations = 0;
  /** Images loaded by view_image during the current turn; flushed into a synthetic
   * user message after the tool calls so the model sees them the next iteration. */
  private pendingImages: ImagePart[] = [];
  /** Monotonic id for permission requests emitted to the bus (web view). */
  private permSeq = 0;

  constructor(deps: EngineDeps) {
    this.apiKey = deps.apiKey;
    this.cwd = deps.cwd;
    this.systemPrompt = deps.systemPrompt;
    this.models = deps.models;
    this.session = deps.session;
    this.skills = deps.skills ?? [];
    this.fallbackModel = deps.fallbackModel;
    this.autoCommit = deps.autoCommit ?? true;
    this.budgetUsd = deps.maxSessionUsd ?? 2;
    this.budgetCeiling = this.budgetUsd;
    this.messages = deps.session.messages;
    this.modelId = deps.session.model;
    this.mode = deps.session.mode;
    this.summary = deps.session.summary;
    this.cost = deps.session.cost;
    this.cost.cachedPromptTokens ??= 0; // older sessions predate the cached-token field
    this.cost.subAgentUsd ??= 0;
    this.cost.oracleUsd ??= 0;
    this.todos = deps.session.todos ?? [];
    // Primary root is always cwd; extra roots are de-duped and must be real dirs.
    this.roots = [this.cwd];
    for (const r of deps.workspaceRoots ?? []) this.addRoot(r);
  }

  // --- state helpers -------------------------------------------------------

  /** Add a workspace root (absolute after resolving against cwd). Rejects a
   * non-directory or a duplicate. Returns the resolved path or an error message. */
  addRoot(p: string): { ok: boolean; message: string } {
    const abs = path.resolve(this.cwd, p);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return { ok: false, message: `not a directory: ${abs}` };
    if (this.roots.some((r) => path.resolve(r) === abs)) return { ok: false, message: `already a workspace root: ${abs}` };
    this.roots.push(abs);
    return { ok: true, message: abs };
  }

  /** Remove a workspace root. The primary root (cwd) can't be removed. */
  removeRoot(p: string): { ok: boolean; message: string } {
    const abs = path.resolve(this.cwd, p);
    if (path.resolve(this.roots[0]!) === abs) return { ok: false, message: "can't remove the primary root (cwd)." };
    const i = this.roots.findIndex((r) => path.resolve(r) === abs);
    if (i < 0) return { ok: false, message: `not a workspace root: ${abs}` };
    this.roots.splice(i, 1);
    return { ok: true, message: abs };
  }

  currentModel(): ModelInfo | undefined {
    return this.models.find((m) => m.id === this.modelId);
  }
  /** True when the session's dollar cost has reached the current ceiling. */
  overBudget(): boolean {
    return this.cost.usd >= this.budgetCeiling;
  }
  /** True when the active model's provider accepts explicit cache_control
   * breakpoints (a non-zero cache-write price in the catalog). */
  supportsCache(): boolean {
    return (this.currentModel()?.pricing.cacheWrite ?? 0) > 0;
  }
  /** True when the active model accepts image input (view_image / @image work). */
  supportsImageInput(): boolean {
    return this.currentModel()?.input_modalities?.includes("image") ?? false;
  }
  /** True when the active model accepts document (PDF) input as a file content block. */
  supportsDocumentInput(): boolean {
    return this.currentModel()?.input_modalities?.includes("file") ?? false;
  }
  /** Attach images to the next user turn (an @image reference typed in the TUI). */
  setNextUserImages(images: ImagePart[]): void {
    this.nextUserImages = images;
  }
  /** Attach documents to the next user turn (a web upload). */
  setNextUserFiles(files: FilePart[]): void {
    this.nextUserFiles = files;
  }
  contextLength(): number {
    return this.currentModel()?.context_length ?? 0;
  }
  contextTokens(): number {
    const est = estimateTokens(this.messages, this.systemPrompt + (this.summary ?? ""));
    return Math.max(est, this.lastPromptTokens);
  }
  /** Single source for the context-usage ratio: the status-bar meter and the
   * compaction trigger both read this, so they can never disagree. */
  contextFraction(): number {
    const cl = this.contextLength();
    return cl > 0 ? this.contextTokens() / cl : 0;
  }
  sessionId(): string {
    return this.session.id;
  }

  /** Tools available for the current mode. Plan mode drops write/edit/bash (and the
   * multi-tab meta-tools), leaving only read-only research tools. */
  availableToolNames(): readonly string[] {
    if (this.toolAllowList) return this.toolAllowList;
    if (this.mode !== "plan") return allToolNames();
    // Plan mode: built-ins keep the existing exclusion set; MCP tools are advertised
    // only when read-only (mutating ones are rejected by the gate anyway).
    return allToolNames().filter((n) => (TOOLS[n] ? !PLAN_EXCLUDED.has(n) : !resolveTool(n)?.mutating));
  }

  /** System prompt for the current turn, with the stated working directory
   * tracking this engine's cwd (so it matches where tools actually run after
   * /vault). In plan mode a directive is appended telling the model to plan. */
  currentSystemPrompt(): string {
    let base = withWorkingDir(this.systemPrompt, this.cwd);
    if (this.roots.length > 1) {
      const list = this.roots.map((r, i) => `  ${i === 0 ? "*" : "-"} ${r}${i === 0 ? " (primary)" : ""}`).join("\n");
      base +=
        `\n\nWorkspace roots — grep/glob WITHOUT a path argument search all of these; ` +
        `each result is prefixed with its root's name. Use an explicit path to scope to one.\n${list}`;
    }
    return this.mode === "plan" ? base + PLAN_DIRECTIVE : base;
  }

  setModel(id: string): void {
    this.modelId = id;
    this.lastPromptTokens = 0;
  }
  setMode(mode: Mode): void {
    this.mode = mode;
    this.bus?.emit({ type: "agent.mode", tabId: this.agentId, mode });
  }
  clear(): void {
    this.messages.length = 0;
    this.summary = null;
    this.todos = [];
    this.lastPromptTokens = 0;
    this.repairs.clear();
    this.rejections.clear();
    this.readFiles.clear();
  }
  abort(): void {
    this.abortController?.abort();
  }
  busy(): boolean {
    return this.abortController !== null;
  }

  /** Swap in a different session's state (the /resume command). */
  adoptSession(s: SessionData): void {
    this.session = s;
    this.messages = s.messages;
    this.modelId = s.model;
    this.mode = s.mode;
    this.summary = s.summary;
    this.cost = s.cost;
    this.cost.cachedPromptTokens ??= 0;
    this.cost.subAgentUsd ??= 0;
    this.cost.oracleUsd ??= 0;
    this.todos = s.todos ?? [];
    this.lastPromptTokens = 0;
    this.repairs.clear();
    this.rejections.clear();
    this.readFiles.clear();
  }

  /** Create a sibling Engine for a new tab: same provider key, system prompt,
   * catalog, and skills, but a fresh session (own history, model, cwd, mode). */
  fork(opts?: { cwd?: string; model?: string; mode?: Mode }): Engine {
    const cwd = opts?.cwd ?? this.cwd;
    const session = createSession(cwd, opts?.model ?? this.modelId, opts?.mode ?? this.mode);
    const engine = new Engine({
      apiKey: this.apiKey,
      cwd,
      systemPrompt: this.systemPrompt,
      models: this.models,
      session,
      skills: this.skills,
      fallbackModel: this.fallbackModel,
      autoCommit: this.autoCommit,
      maxSessionUsd: this.budgetUsd,
    });
    engine.interactive = this.interactive;
    return engine;
  }

  async persist(): Promise<void> {
    if (this.noPersist) return; // ephemeral sub-agent session
    this.session.messages = this.messages;
    this.session.model = this.modelId;
    this.session.mode = this.mode;
    this.session.summary = this.summary;
    this.session.cost = this.cost;
    this.session.todos = this.todos;
    await saveSession(this.session);
  }

  // --- cost ----------------------------------------------------------------

  /** Apply a completion's usage to the running cost and return the dollar cost of
   * this call (for the trace). */
  private applyUsage(usage: Usage): number {
    this.cost.promptTokens += usage.prompt_tokens;
    this.cost.cachedPromptTokens += usage.cached_tokens;
    this.cost.completionTokens += usage.completion_tokens;
    let dollars = usage.cost;
    if (!(dollars > 0)) {
      const pm = this.currentModel();
      if (pm) {
        dollars = usage.prompt_tokens * pm.pricing.prompt + usage.completion_tokens * pm.pricing.completion;
      }
    }
    const applied = dollars > 0 ? dollars : 0;
    this.cost.usd += applied;
    if (usage.prompt_tokens > 0) this.lastPromptTokens = usage.prompt_tokens;
    return applied;
  }

  /** Append a trace event for this session — skipped for ephemeral sessions
   * (sub-agents, eval, pipe without --save) so traces reflect real sessions. */
  private async trace(event: TraceEvent): Promise<void> {
    if (this.noPersist) return;
    await appendTrace(this.sessionId(), event);
  }

  /** Parse a tool call's raw JSON args for the trace; never throws. */
  private parseArgs(argsJson: string): unknown {
    try {
      return argsJson && argsJson.trim() ? JSON.parse(argsJson) : {};
    } catch {
      return { _raw: argsJson };
    }
  }

  // --- the loop ------------------------------------------------------------

  /** Wrap the TUI callbacks so the same activity also fans out to the event bus
   * (the web view). tool.start and permission.request originate here; the
   * persistent transcript lines are mirrored by the UI's own sink so the browser
   * shows byte-identical content. permission requests are routed through the
   * bridge so either the TUI overlay OR a web client can answer (first wins). */
  private wrapCallbacks(cb: Callbacks): Callbacks {
    const bus = this.bus;
    const bridge = this.bridge;
    if (!bus) return cb;
    const tabId = this.agentId;
    return {
      ...cb,
      onToolStart: (call, args) => {
        try {
          bus.emit({ type: "tool.start", tabId, tool: call.name, args });
        } catch {
          /* emit and forget */
        }
        cb.onToolStart(call, args);
      },
      requestPermission: (preview) => {
        if (!bridge) {
          bus.emit({ type: "permission.request", tabId, id: `${tabId}:${++this.permSeq}`, preview, options: ["yes", "no", "always"] });
          return cb.requestPermission(preview);
        }
        const id = `${tabId}:${++this.permSeq}`;
        return new Promise<PermissionAnswer>((resolve) => {
          let done = false;
          const finish = (a: PermissionAnswer) => {
            if (done) return;
            done = true;
            bridge.clearPermission(id);
            bus.emit({ type: "permission.resolved", tabId, id, answer: a });
            resolve(a);
          };
          bridge.registerPermission(id, finish); // a web client may answer
          bus.emit({ type: "permission.request", tabId, id, preview, options: ["yes", "no", "always"] });
          void Promise.resolve(cb.requestPermission(preview)).then(finish); // the TUI overlay
        });
      },
    };
  }

  async run(userText: string, cb: Callbacks): Promise<void> {
    cb = this.wrapCallbacks(cb);
    // Snapshot cost so we can report this turn's delta (sub-agent cost included).
    const costAtStart = {
      prompt: this.cost.promptTokens,
      completion: this.cost.completionTokens,
      cached: this.cost.cachedPromptTokens,
      usd: this.cost.usd,
    };
    // Attach any images/documents queued for this turn (@image in the TUI, or a web upload).
    const images = this.nextUserImages;
    const files = this.nextUserFiles;
    this.nextUserImages = [];
    this.nextUserFiles = [];
    this.pendingImages = [];
    this.editedThisTurn = false;
    this.fixIterations = 0;
    this.turnEditedFiles = new Set();
    this.turnBaseSha = undefined;
    this.turnRequest = userText;
    this.messages.push({ role: "user", text: userText, images: images.length ? images : undefined, files: files.length ? files : undefined });
    await this.trace({ type: "turn", role: "user", text: userText.slice(0, 500) });
    this.abortController = new AbortController();
    this.repairs.clear();
    this.rejections.clear();
    this.stopTurn = false;
    this.sizeRetried = false;
    this.capped = null;

    let iter = 0;
    try {
      for (; iter < this.maxIterations; iter++) {
        // Sub-agent context budget: stop cleanly once the cap is reached.
        if (this.cost.promptTokens + this.cost.completionTokens >= this.tokenBudget) {
          this.capped = "token";
          break;
        }
        // Dollar budget ceiling: on reaching it, prompt to continue or stop. "no"
        // halts the turn; "yes" grants another allotment; "always" lifts it for the
        // session. Non-interactive (headless/pipe/sub-agent) halts.
        if (this.overBudget()) {
          const q = `Session cost $${this.cost.usd.toFixed(4)} reached the $${this.budgetCeiling.toFixed(2)} budget ceiling. Continue?`;
          const ans = this.interactive
            ? await cb.requestPermission({ kind: "bash", command: q, dangerous: true, cwd: this.cwd, warning: `budget ceiling — 'always' lifts it, otherwise +$${this.budgetUsd.toFixed(2)}` })
            : "no";
          if (ans === "no") {
            this.capped = "budget";
            cb.onSystem(`✗ halted at the $${this.budgetCeiling.toFixed(2)} budget ceiling (cost $${this.cost.usd.toFixed(4)}). Raise it with /budget <usd> or config maxSessionUsd.`);
            break;
          }
          this.budgetCeiling = ans === "always" ? Infinity : this.budgetCeiling + this.budgetUsd;
          cb.onSystem(ans === "always" ? "↑ budget ceiling lifted for this session" : `↑ budget ceiling raised to $${this.budgetCeiling.toFixed(2)}`);
        }
        if (shouldCompact(this.messages, this.contextTokens(), this.contextLength())) {
          this.doCompact(cb);
        }

        const wire = serialize(this.messages, this.currentSystemPrompt(), this.summary, { images: this.supportsImageInput(), documents: this.supportsDocumentInput() });
        // Markdown is stripped from the visible text as it streams (never a
        // post-hoc pass), so the output can't flash raw markdown then correct
        // itself. Only text flows through here — tool-call args are on a separate
        // channel and are never touched. The stored message keeps the model's
        // original text so history the model sees stays faithful.
        const stripper = new MarkdownStripper();
        let result;
        try {
          result = await streamCompletion(
            {
              apiKey: this.apiKey,
              model: this.modelId,
              messages: wire,
              tools: toolDefinitions(this.availableToolNames()),
              signal: this.abortController.signal,
              // Recomputed each iteration so a mid-turn fallback to a non-caching
              // model correctly stops sending cache_control.
              cache: this.supportsCache(),
            },
            // Each completed line commits to the transcript as it finalizes; the
            // still-forming line is shown transiently via onPending. Only text
            // flows through here — tool-call args are on a separate channel.
            (delta) => {
              const { lines, pending } = stripper.push(delta);
              for (const line of lines) cb.onLine(line);
              cb.onPending(pending);
            },
          );
        } catch (e) {
          if (this.abortController.signal.aborted) {
            // Committed lines stay (the user saw them); the unfinished partial is
            // dropped by clearing the live region. Mark the turn aborted.
            cb.onSystem("⎿ aborted");
            break;
          }
          // A model that's gone (404) or throttled by an upstream shared pool won't
          // recover on retry. Switch to the configured fallback for the rest of the
          // session (once) and re-run this turn on it. Guard modelId !== fallback so
          // a failing fallback surfaces the error instead of looping.
          if (e instanceof FallbackNeededError && this.fallbackModel && this.modelId !== this.fallbackModel) {
            const from = this.modelId;
            const why = e.status === 404 ? "not found (404)" : "rate-limited upstream (shared pool)";
            this.setModel(this.fallbackModel);
            cb.onSystem(`↪ ${from} ${why} — falling back to ${this.fallbackModel} for this session`);
            continue; // retry this turn on the fallback model
          }
          // 413 (too large for the model's limit): retrying sends the same bytes, so
          // compact + retry ONCE; if still too large, fall back to a larger model;
          // else surface a clear, actionable error. Never a plain backoff retry.
          if (e instanceof TooLargeError) {
            if (!this.sizeRetried) {
              this.sizeRetried = true;
              cb.onSystem("⟳ request too large — compacting and retrying");
              this.doCompact(cb);
              continue;
            }
            if (this.fallbackModel && this.modelId !== this.fallbackModel) {
              const from = this.modelId;
              this.setModel(this.fallbackModel);
              cb.onSystem(`↪ still too large for ${from} — falling back to ${this.fallbackModel} (larger capacity) for this session`);
              continue;
            }
            const limit = limitPhrase(e.detail);
            cb.onSystem(
              `✗ request too large for ${this.modelId}'s token limit${limit ? ` (${limit})` : ""}. ` +
                `Run /compact or /clear to shrink the conversation` +
                (this.fallbackModel ? "." : ', or set a larger "fallbackModel" in ~/.dom/config.json.'),
            );
            break;
          }
          if (e instanceof ProviderError) {
            cb.onSystem(`✗ ${e.message}`);
          } else {
            cb.onSystem(`✗ ${(e as Error).message}`);
          }
          break;
        }

        // Commit the final partial line, then clear the live region.
        const last = stripper.flush();
        if (last) cb.onLine(last);
        cb.onPending("");

        const callCost = this.applyUsage(result.usage);
        await this.trace({
          type: "model_call",
          model: this.modelId,
          promptTokens: result.usage.prompt_tokens,
          completionTokens: result.usage.completion_tokens,
          cachedTokens: result.usage.cached_tokens,
          cost: callCost,
          toolCalls: result.toolCalls.length,
        });
        const assistant: Extract<Msg, { role: "assistant" }> = {
          role: "assistant",
          text: result.text || undefined,
          calls: result.toolCalls.length ? result.toolCalls : undefined,
        };
        this.messages.push(assistant);
        // The response text is already in the transcript line-by-line; onAssistant
        // only marks completion. History keeps the model's original text.
        cb.onAssistant(assistant);

        if (!result.toolCalls.length) {
          // Auto lint/test loop: if this turn edited files, run the checks; on
          // failure feed it back and let the model fix (cap MAX_FIX_ITERATIONS).
          if (this.editedThisTurn && !this.abortController.signal.aborted) {
            const checks = await this.runChecks(cb);
            if (checks && !checks.ok) {
              if (this.fixIterations < MAX_FIX_ITERATIONS) {
                this.fixIterations++;
                this.editedThisTurn = false;
                this.messages.push({
                  role: "user",
                  text: `Automated checks failed after your edits. Fix the code so they pass, then stop.\n\n${checks.report}`,
                });
                cb.onSystem(`⟳ checks failed — fix attempt ${this.fixIterations}/${MAX_FIX_ITERATIONS}`);
                continue;
              }
              cb.onSystem(`✗ checks still failing after ${MAX_FIX_ITERATIONS} fix attempts — stopping`);
            } else if (checks && checks.ok && this.fixIterations > 0) {
              cb.onSystem("✓ checks pass");
            }
          }
          break;
        }

        let stop = false;
        for (const call of result.toolCalls) {
          if (this.abortController.signal.aborted) {
            this.messages.push({ role: "tool", callId: call.id, name: call.name, result: "■ aborted", isError: true });
            stop = true;
            break;
          }
          const res = await this.gateAndExecute(call, cb);
          // Redact secrets from the tool RESULT before it reaches history (→ the
          // model + session file) or the transcript. Results aren't re-executed, so
          // this is always safe.
          const red = redactSecrets(res.output);
          if (red.count) {
            res.output = red.text;
            cb.onSystem(`🔒 redacted ${red.count} secret${red.count === 1 ? "" : "s"} from ${call.name} output`);
          }
          this.messages.push({ role: "tool", callId: call.id, name: call.name, result: res.output, isError: res.isError });
          await this.trace({
            type: "tool_call",
            name: call.name,
            args: truncateDeep(this.parseArgs(call.args)),
            isError: res.isError,
            outputChars: res.output.length,
          });
          cb.onToolResult(call, res);
          if (this.stopTurn) {
            stop = true;
            break;
          }
        }
        // Redact secrets the model put in its own tool-call args (e.g. a curl with
        // a token) from the STORED history + session file. Execution already ran
        // with the real args above, so this changes only the model-facing/on-disk
        // copy (the transcript display is redacted separately in toolrender).
        for (const c of assistant.calls ?? []) {
          const r = redactSecrets(c.args);
          if (r.count) c.args = r.text;
        }
        // Images loaded by view_image this turn ride in on a synthetic user message
        // right after the tool results, so the model sees them the next iteration.
        // (OpenAI-format images live in user messages, not tool results.)
        if (this.pendingImages.length) {
          this.messages.push({ role: "user", text: "", images: this.pendingImages });
          this.pendingImages = [];
        }
        if (stop) break;
      }
      if (iter >= this.maxIterations) {
        this.capped ??= "iteration";
        cb.onSystem(`✗ hit ${this.maxIterations}-iteration cap for this turn`);
      }
      // Auto-verify: on a turn that touched 2+ files, spawn a read-only verifier
      // (config autoVerify) that judges the diff against the request, blind to the
      // generator's reasoning, and reports its verdict.
      if (!this.abortController.signal.aborted && this.turnEditedFiles.size >= 2 && (await loadConfig()).autoVerify) {
        cb.onSystem("⟳ verifying the change…");
        const v = await this.runVerifier();
        if (v) cb.onSystem(v.verdict === "pass" ? `✓ verifier: ${v.text}` : `✗ verifier (${v.verdict}): ${v.text}`);
      }
      // Stop hook (non-blocking): the turn has ended.
      const stopHook = await runNonBlockingHook(this.cwd, "Stop", { sessionId: this.sessionId(), model: this.modelId });
      if (stopHook.warn) cb.onSystem(`! ${stopHook.warn}`);
    } finally {
      this.abortController = null;
      cb.onTurnCost?.({
        promptTokens: this.cost.promptTokens - costAtStart.prompt,
        completionTokens: this.cost.completionTokens - costAtStart.completion,
        cachedTokens: this.cost.cachedPromptTokens - costAtStart.cached,
        usd: this.cost.usd - costAtStart.usd,
      });
      await this.persist();
    }
  }

  private doCompact(cb: Callbacks): void {
    const { summary, kept } = compact(this.messages);
    if (!summary) return;
    this.summary = this.summary ? `${this.summary}\n\n${summary}` : summary;
    this.messages = kept;
    this.session.messages = this.messages;
    cb.onSystem("⟳ compacted");
  }

  /** Force compaction (the /compact command). */
  forceCompact(cb: Callbacks): void {
    if (this.messages.length <= 12) {
      cb.onSystem("nothing to compact yet");
      return;
    }
    this.doCompact(cb);
  }

  private schemaFailure(toolName: string, message: string, cb: Callbacks): ToolResult {
    const n = (this.repairs.get(toolName) ?? 0) + 1;
    this.repairs.set(toolName, n);
    if (n > 2) {
      this.stopTurn = true;
      cb.onSystem(`✗ ${toolName}: schema repair limit reached — surfacing failure`);
      return { output: `${toolName} failed: ${message}\n(repair limit reached; abandoning this call)`, isError: true };
    }
    const schema = JSON.stringify(toJsonSchema(TOOLS[toolName]!.schema));
    return {
      output:
        `${toolName} argument error (repair ${n}/2): ${message}\n` +
        `Expected JSON Schema for ${toolName}:\n${schema}\n` +
        `Correct the arguments and call the tool again.`,
      isError: true,
    };
  }

  /**
   * The tool result for a user-rejected call. The model is told the user
   * declined and to ASK rather than retry. Rejections are counted per target
   * (tool + path/url/command); a second rejection of the SAME target ends the
   * turn and hands control back to the user instead of looping on a "no".
   */
  private rejectionResult(tool: ToolDef, args: unknown, cb: Callbacks): ToolResult {
    const key = rejectionKey(this.cwd, tool, args);
    const label = targetLabel(this.cwd, tool, args);
    const n = (this.rejections.get(key) ?? 0) + 1;
    this.rejections.set(key, n);
    if (n >= 2) {
      this.stopTurn = true;
      cb.onSystem(`✗ ${tool.name} (${label}) declined twice — ending turn, over to you`);
      return {
        output:
          `The user declined this ${tool.name} (${label}) for the second time. ` +
          `Do not attempt it again. The turn is ending and control returns to the user — ` +
          `wait for them to tell you what to change.`,
        isError: true,
      };
    }
    return {
      output:
        `The user declined this ${tool.name} (${label}). Do not retry the same call or a ` +
        `trivial variation of it (e.g. a renamed path). Ask the user what they want changed ` +
        `before trying again.`,
      isError: true,
    };
  }

  /** Context handed to tools: multi-tab access, the sub-agent runner for `task`,
   * the task-list setter for `todo`, and image input/attach for `view_image`. */
  private toolCtx(): ToolContext {
    return {
      cwd: this.cwd,
      roots: this.roots,
      tab: this.toolContext?.tab,
      subagent: (d, p, sig) => this.runSubAgent(d, p, sig),
      // Only the top-level agent can coordinate; a sub-agent gets no runner, so a
      // sub-agent that reaches for coordinated subtasks is refused by the task tool.
      coordinate: this.isSubAgent ? undefined : (subtasks, sig) => this.runCoordinatedTask(subtasks, sig),
      setTodos: (items) => {
        this.todos = items;
      },
      imageInput: this.supportsImageInput(),
      attachImage: (img) => {
        this.pendingImages.push(img);
      },
      oracle: (q, sig) => this.runOracle(q, sig),
    };
  }

  /**
   * Run a read-only sub-agent to completion and return only its final text. The
   * sub-agent is a fresh, ephemeral Engine with its own history and context budget,
   * restricted to read/glob/grep/http (no recursion) and hard-capped at 15
   * iterations / 50k tokens. Its intermediate turns never enter this engine's
   * history; its cost folds into ours and is tracked separately for /cost.
   */
  async runSubAgent(
    description: string,
    prompt: string,
    signal?: AbortSignal,
    opts?: { maxIter?: number; tokenBudget?: number },
  ): Promise<SubAgentResult> {
    if (this.overBudget()) return { text: "Refused: the session budget ceiling has been reached — not spawning a sub-agent.", tools: 0, tokens: 0, capped: "budget" };
    this.bus?.emit({ type: "subagent.start", tabId: this.agentId, description });
    const session = createSession(this.cwd, this.modelId, "yolo"); // read-only tools; yolo only avoids prompts
    const sub = new Engine({
      apiKey: this.apiKey,
      cwd: this.cwd,
      systemPrompt: this.systemPrompt + SUBAGENT_DIRECTIVE, // inherits the repo map baked into systemPrompt
      models: this.models,
      session,
      skills: this.skills,
      autoCommit: false,
    });
    sub.toolAllowList = SUBAGENT_TOOLS;
    sub.maxIterations = opts?.maxIter ?? SUBAGENT_MAX_ITER;
    sub.tokenBudget = opts?.tokenBudget ?? SUBAGENT_TOKEN_BUDGET;
    sub.interactive = false;
    sub.noPersist = true;
    sub.isSubAgent = true;
    if (signal) signal.addEventListener("abort", () => sub.abort(), { once: true });

    let tools = 0;
    const cb: Callbacks = {
      onLine() {},
      onPending() {},
      onAssistant() {},
      onToolStart() {
        tools++;
      },
      onToolResult() {},
      onSystem() {},
      requestPermission: async () => "no", // never prompt; unsafe calls are simply refused
    };
    // The sub-agent engine owns cwd = this.cwd, and its tools resolve against that
    // (via ctx.cwd) — so it searches the parent's working root without any global
    // process.chdir. Nothing to save or restore, and aborting mid-run leaves no
    // cwd change behind.
    await sub.run(prompt, cb);

    const text =
      [...sub.messages].reverse().find((m): m is Extract<Msg, { role: "assistant" }> => m.role === "assistant" && !!m.text)?.text ??
      "(sub-agent produced no summary)";
    const tokens = sub.cost.promptTokens + sub.cost.completionTokens;
    // Fold the sub-agent's spend into this session; keep the sub-agent slice for /cost.
    this.cost.promptTokens += sub.cost.promptTokens;
    this.cost.cachedPromptTokens += sub.cost.cachedPromptTokens;
    this.cost.completionTokens += sub.cost.completionTokens;
    this.cost.usd += sub.cost.usd;
    this.cost.subAgentUsd = (this.cost.subAgentUsd ?? 0) + sub.cost.usd;
    (this.cost.subAgents ??= []).push({ label: description, usd: sub.cost.usd });
    this.bus?.emit({ type: "subagent.end", tabId: this.agentId, description, result: text.slice(0, 500) });
    return { text, tools, tokens, capped: sub.capped };
  }

  /**
   * Coordinated task: spawn every subtask as its own read-only sub-agent, ALL in
   * parallel, each with a tight isolated budget (8 iterations / 15k tokens). Each
   * sub-agent emits its own subagent.start/end on the bus, so the web floor shows
   * one figure per subtask appearing at once and vanishing individually as each
   * finishes. Only the final summaries return to the caller (the coordinator) —
   * every intermediate tool call stays inside the sub-agent and never enters this
   * engine's history. Per-sub-agent cost lands in this.cost.subAgents for /cost.
   */
  async runCoordinatedTask(
    subtasks: { description: string; prompt: string }[],
    signal?: AbortSignal,
  ): Promise<CoordinatedResult[]> {
    return Promise.all(
      subtasks.map(async (t) => {
        const res = await this.runSubAgent(t.description, t.prompt, signal, {
          maxIter: COORD_SUBAGENT_MAX_ITER,
          tokenBudget: COORD_SUBAGENT_TOKEN_BUDGET,
        });
        return { ...res, description: t.description };
      }),
    );
  }

  /**
   * Consult the stronger oracle model (config `oracleModel`, else the session
   * model) on a hard sub-problem: a SINGLE completion, no tools, isolated context
   * (only the question). Its tokens fold into the session cost; the dollar spend is
   * also tracked separately (cost.oracleUsd) for /cost. Nothing enters history.
   */
  async runOracle(question: string, signal?: AbortSignal): Promise<{ text: string; model: string; tokens: number; usd: number }> {
    if (this.overBudget()) return { text: "Refused: the session budget ceiling has been reached — not consulting the oracle.", model: this.modelId, tokens: 0, usd: 0 };
    const cfg = await loadConfig();
    const model = cfg.oracleModel || this.modelId;
    const system =
      "You are an expert consultant answering ONE hard question in a single turn. You have no tools and no access " +
      "to the caller's files, history, or repo — reason from the question alone and from your own knowledge. Answer " +
      "directly and correctly, showing the key reasoning concisely.";
    const wire = serialize([{ role: "user", text: question }], system, null);
    const result = await streamCompletion(
      {
        apiKey: this.apiKey,
        model,
        messages: wire,
        tools: [],
        signal: signal ?? this.abortController?.signal ?? new AbortController().signal,
        cache: false,
      },
      () => {},
    );
    let dollars = result.usage.cost;
    if (!(dollars > 0)) {
      const pm = this.models.find((m) => m.id === model);
      if (pm) dollars = result.usage.prompt_tokens * pm.pricing.prompt + result.usage.completion_tokens * pm.pricing.completion;
    }
    dollars = dollars > 0 ? dollars : 0;
    this.cost.promptTokens += result.usage.prompt_tokens;
    this.cost.completionTokens += result.usage.completion_tokens;
    this.cost.usd += dollars;
    this.cost.oracleUsd = (this.cost.oracleUsd ?? 0) + dollars;
    return { text: result.text || "(the oracle returned no answer)", model, tokens: result.usage.prompt_tokens + result.usage.completion_tokens, usd: dollars };
  }

  /**
   * Auto lint/test loop check: when autoFix is on and lint/test commands are
   * configured, run them in this.cwd. Returns null when disabled/unconfigured,
   * else { ok, report } where report is the concatenated failure output. Commands
   * are user-configured (trusted), so they run without a permission prompt.
   */
  private async runChecks(cb: Callbacks): Promise<{ ok: boolean; report: string } | null> {
    const cfg = await loadConfig();
    if (!cfg.autoFix) return null;
    const checks = ([["lint", cfg.lintCommand], ["test", cfg.testCommand]] as const).filter(([, c]) => !!c);
    if (!checks.length) return null;
    const failures: string[] = [];
    for (const [label, cmd] of checks) {
      cb.onSystem(`⟳ ${label}: ${cmd}`);
      const res = await runBash({ command: cmd! }, this.abortController?.signal, this.toolCtx());
      if (res.aborted) return { ok: true, report: "" }; // aborted — don't loop
      if (res.isError) failures.push(`${label} (\`${cmd}\`) failed:\n${res.output}`);
    }
    return { ok: failures.length === 0, report: failures.join("\n\n") };
  }

  /**
   * Spawn a read-only verifier subagent that sees ONLY the original request and
   * the diff of this turn's edits — never the generator's reasoning — and judges
   * skeptically whether the change is actually done. Returns the verdict + notes,
   * or null when there's nothing to verify (no edits / no diff). Cost folds in.
   */
  async runVerifier(): Promise<{ verdict: "pass" | "fail" | "unknown"; text: string } | null> {
    if (this.overBudget() || !this.turnEditedFiles.size) return null;
    const rel = [...this.turnEditedFiles].map((f) => path.relative(this.cwd, f).split(path.sep).join("/"));
    const diff = await gitDiff(this.cwd, this.turnBaseSha ?? null, rel);
    if (!diff) return null;

    const session = createSession(this.cwd, this.modelId, "yolo");
    const sub = new Engine({ apiKey: this.apiKey, cwd: this.cwd, systemPrompt: VERIFIER_DIRECTIVE, models: this.models, session, skills: [], autoCommit: false });
    sub.toolAllowList = []; // NO tools — judge from the request + diff alone
    sub.maxIterations = 2;
    sub.tokenBudget = 30_000;
    sub.interactive = false;
    sub.noPersist = true;

    const prompt = `ORIGINAL REQUEST:\n${this.turnRequest}\n\nDIFF (files: ${rel.join(", ")}):\n${diff.slice(0, 24000)}`;
    const noop: Callbacks = { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult() {}, onSystem() {}, requestPermission: async () => "no" };
    await sub.run(prompt, noop);

    // Fold the verifier's cost into this session.
    this.cost.promptTokens += sub.cost.promptTokens;
    this.cost.completionTokens += sub.cost.completionTokens;
    this.cost.usd += sub.cost.usd;

    const text =
      [...sub.messages].reverse().find((m): m is Extract<Msg, { role: "assistant" }> => m.role === "assistant" && !!m.text)?.text ??
      "(verifier produced no verdict)";
    const first = text.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
    const verdict = first.startsWith("PASS") ? "pass" : first.startsWith("FAIL") ? "fail" : "unknown";
    return { verdict, text: text.trim() };
  }

  /** Set (or update) the goal bar. Rounds reset to maxRounds unless the caller
   * pins them; toggling `active` off pauses reviews without losing the goal. */
  setGoal(g: { text: string; maxRounds?: number; reviewModel?: string; active?: boolean; roundsLeft?: number }): GoalState {
    const maxRounds = Math.max(1, g.maxRounds ?? this.goal?.maxRounds ?? 3);
    this.goal = {
      text: g.text,
      active: g.active ?? true,
      maxRounds,
      roundsLeft: g.roundsLeft ?? maxRounds,
      reviewModel: g.reviewModel ?? this.goal?.reviewModel,
    };
    return this.goal;
  }

  clearGoal(): void {
    this.goal = null;
  }

  /**
   * The goal-bar review: the SAME read-only verifier subagent (VERIFIER_DIRECTIVE,
   * no tools, isolated context) judges `git diff HEAD` against the standing goal —
   * never the conversation. On PASS it returns the verdict; on FAIL it burns a
   * round and returns a `steer` (the reviewer's feedback) to feed back as the next
   * turn. Returns null when there's no active goal, no rounds left, the turn
   * touched no files, or there's nothing in the diff.
   */
  async runGoalReview(): Promise<GoalReview | null> {
    const goal = this.goal;
    if (!goal || !goal.active || goal.roundsLeft <= 0) return null;
    if (this.overBudget() || !this.turnEditedFiles.size) return null;
    const diff = await gitDiffHead(this.cwd);
    if (!diff) return null;

    // Review model: the picked one if valid, else config.oracleModel, else the
    // session model (mirrors the oracle tool's stronger-model selection).
    let model = this.modelId;
    if (goal.reviewModel && this.models.some((m) => m.id === goal.reviewModel)) {
      model = goal.reviewModel;
    } else {
      const cfg = await loadConfig();
      if (cfg.oracleModel && this.models.some((m) => m.id === cfg.oracleModel)) model = cfg.oracleModel;
    }

    const session = createSession(this.cwd, model, "yolo");
    const sub = new Engine({ apiKey: this.apiKey, cwd: this.cwd, systemPrompt: VERIFIER_DIRECTIVE, models: this.models, session, skills: [], autoCommit: false });
    sub.toolAllowList = []; // NO tools — judge from the goal + diff alone
    sub.maxIterations = 2;
    sub.tokenBudget = 30_000;
    sub.interactive = false;
    sub.noPersist = true;

    const prompt = `ORIGINAL REQUEST (the GOAL):\n${goal.text}\n\nDIFF (git diff HEAD):\n${diff.slice(0, 24000)}`;
    const noop: Callbacks = { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult() {}, onSystem() {}, requestPermission: async () => "no" };
    await sub.run(prompt, noop);

    // Fold the reviewer's cost into this session.
    this.cost.promptTokens += sub.cost.promptTokens;
    this.cost.completionTokens += sub.cost.completionTokens;
    this.cost.usd += sub.cost.usd;

    const text =
      [...sub.messages].reverse().find((m): m is Extract<Msg, { role: "assistant" }> => m.role === "assistant" && !!m.text)?.text ??
      "(reviewer produced no verdict)";
    const first = text.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
    const verdict = first.startsWith("PASS") ? "pass" : first.startsWith("FAIL") ? "fail" : "unknown";

    if (verdict === "pass") {
      return { verdict, text: text.trim(), roundsLeft: goal.roundsLeft, active: goal.active };
    }
    // FAIL/unknown: burn a round and steer the agent back to the goal.
    goal.roundsLeft -= 1;
    const round = goal.maxRounds - goal.roundsLeft;
    const steer =
      `⟳ GOAL REVIEW — FAIL (round ${round}/${goal.maxRounds}). The changes so far do NOT satisfy the goal:\n` +
      `${goal.text}\n\nReviewer feedback:\n${text.trim()}\n\n` +
      `Keep working until the goal is fully met. Do not stop to ask; make the change.`;
    return { verdict, text: text.trim(), roundsLeft: goal.roundsLeft, active: goal.active, steer };
  }

  private async gateAndExecute(call: ToolCall, cb: Callbacks): Promise<ToolResult> {
    const tool = resolveTool(call.name);
    if (!tool) return { output: `unknown tool: ${call.name}`, isError: true };
    // Belt-and-braces: the tool isn't even advertised here, but if the model
    // hallucinates one anyway, refuse it. Sub-agents (allow-list) see it as an
    // unknown tool; plan mode explains the restriction.
    if (!this.availableToolNames().includes(call.name)) {
      const why = this.toolAllowList ? `unknown tool: ${call.name}` : `${call.name} is not available in ${this.mode} mode`;
      return { output: why, isError: true };
    }

    let raw: unknown;
    try {
      raw = call.args && call.args.trim() ? JSON.parse(call.args) : {};
    } catch (e) {
      return this.schemaFailure(tool.name, `arguments are not valid JSON: ${(e as Error).message}`, cb);
    }
    const parsed = tool.schema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n");
      return this.schemaFailure(tool.name, `arguments do not match schema:\n${issues}`, cb);
    }
    this.repairs.delete(tool.name); // parsed cleanly — reset repair counter

    const args = parsed.data;

    // PreToolUse hook (blocking): a clean non-zero exit refuses the call with its
    // stderr as the tool error; a timeout/crash warns and lets the call through.
    const pre = await runPreToolUse(this.cwd, tool.name, args);
    if (pre.warn) cb.onSystem(`! ${pre.warn}`);
    if (pre.block) return { output: pre.reason ?? "Blocked by PreToolUse hook.", isError: true };

    const decision = gate(tool, args, { mode: this.mode, approvals: this.approvals, cwd: this.cwd });
    if (decision.kind === "reject") return { output: decision.reason, isError: true };

    // File edits get a unified-diff preview + confirm before applying — but first
    // enforce read-before-edit (edit, and overwrite of an existing file, require a
    // fresh prior read this session).
    if (tool.name === "write" || tool.name === "edit") {
      const stale = await this.precheckStale(tool.name, args);
      if (stale) return { output: stale, isError: true };
      return this.gatedFileEdit(tool, args, call, cb, decision);
    }

    cb.onToolStart(call, args);
    if (decision.kind === "prompt") {
      const preview =
        tool.name === "http"
          ? buildHttpPreview(args.method, String(args.url ?? ""), decision.dangerous)
          : tool.source === "mcp"
            ? buildBashPreview(this.cwd, `${tool.name}(${compactArgs(args)})`, decision.reason ?? "MCP tool call")
            : buildBashPreview(this.cwd, String(args.command ?? ""), decision.reason);
      const ans = await cb.requestPermission(preview);
      if (ans === "no") return this.rejectionResult(tool, args, cb);
      if (ans === "always" && !decision.dangerous) this.approvals.add(approvalKey(tool, args));
    }

    let result: ToolResult;
    try {
      result = await tool.run(args, this.abortController?.signal, this.toolCtx());
    } catch (e) {
      return { output: `${tool.name}: ${(e as Error).message}`, isError: true };
    }
    // Reading a file records its mtime, so a later edit can require the model to
    // have seen the current content (see precheckStale).
    if (tool.name === "read" && !result.isError) await this.recordRead(String(args.path ?? ""));
    await this.postHook(tool.name, args, result, cb);
    return result;
  }

  /** PostToolUse hook (non-blocking): fired after a tool actually executes. */
  private async postHook(name: string, args: unknown, result: ToolResult, cb: Callbacks): Promise<void> {
    const { warn } = await runNonBlockingHook(this.cwd, "PostToolUse", {
      tool: name,
      args,
      result: { output: result.output, isError: result.isError },
    });
    if (warn) cb.onSystem(`! ${warn}`);
  }

  /** Record that a file was read this session, at its current mtime. */
  private async recordRead(p: string): Promise<void> {
    try {
      const abs = path.resolve(this.cwd, p);
      const st = await fs.stat(abs);
      this.readFiles.set(abs, st.mtimeMs);
    } catch {
      /* unreadable — nothing to record */
    }
  }

  /**
   * Read-before-edit guard. Returns an error string when the call must be refused:
   * editing (or overwriting) a file the model hasn't read this session, or one that
   * changed on disk since it read it. Creating a NEW file with write is exempt.
   */
  private async precheckStale(tool: "write" | "edit", args: any): Promise<string | null> {
    const abs = path.resolve(this.cwd, String(args.path ?? ""));
    let st: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      st = await fs.stat(abs);
    } catch {
      st = null;
    }
    // No file on disk: creating a new file with write is exempt; a missing edit
    // target is left to the tool to report the real ENOENT.
    if (!st) return null;
    const readAt = this.readFiles.get(abs);
    if (readAt === undefined) {
      return `Refusing to ${tool} ${args.path}: you haven't read it this session. Read it first, then ${tool} it.`;
    }
    if (st.mtimeMs !== readAt) {
      this.readFiles.delete(abs); // force a fresh read before any edit
      return `Refusing to ${tool} ${args.path}: it changed on disk since you read it. Read it again to see the current content, then ${tool} it.`;
    }
    return null;
  }

  /**
   * Preview a write/edit as a coloured unified diff and confirm before applying.
   * Applies directly (no prompt) when non-interactive (headless), in yolo/approved
   * mode, or once the session 'always' flag is set. Checkpointing is unchanged —
   * it runs inside tool.run, only when the edit is actually applied.
   */
  private async gatedFileEdit(
    tool: ToolDef,
    args: any,
    call: ToolCall,
    cb: Callbacks,
    decision: GateDecision,
  ): Promise<ToolResult> {
    const apply = async (): Promise<ToolResult> => {
      cb.onToolStart(call, args);
      return this.runAndCommit(tool, args, cb);
    };

    // A dangerous target (home dir, non-project git, ...) ALWAYS prompts — neither
    // yolo nor the session 'always'/auto-accept flag may wave it through.
    const forcePrompt = decision.kind === "prompt" && decision.dangerous;
    const dangerReason = decision.kind === "prompt" ? decision.reason : undefined;
    if (forcePrompt && !this.interactive) {
      // No interactive UI to confirm — refuse rather than silently apply.
      return {
        output: `Refused: ${dangerReason ?? "dangerous target"} — run interactively to confirm.`,
        isError: true,
      };
    }
    // No prompt: headless, yolo/approved, or the session already opted into 'always'.
    if (!forcePrompt && (decision.kind !== "prompt" || !this.interactive || this.autoApproveEdits)) {
      return apply();
    }

    // Compute the change to show. If it can't be computed (missing/ambiguous
    // target), skip the prompt and let tool.run surface the real error.
    const plan = tool.name === "write" ? await planWrite(args, this.cwd) : await planEdit(args, this.cwd);
    if ("error" in plan) return apply();

    const preview = buildDiffPreview(
      tool.name === "edit" ? "edit" : "write",
      plan.relPath,
      plan.absPath,
      plan.oldContent,
      plan.newContent,
      forcePrompt ? dangerReason : undefined,
    );
    cb.onToolStart(call, args);
    const ans = await cb.requestPermission(preview);
    if (ans === "no") return this.rejectionResult(tool, args, cb);
    // 'always' opts the session into auto-accepting edits — but never for a
    // dangerous target, which must keep prompting every time.
    if (ans === "always" && !forcePrompt) this.autoApproveEdits = true;
    return this.runAndCommit(tool, args, cb);
  }

  /** Run a file tool and, on success, auto-commit the file it touched (write/edit
   * only; no-op when autoCommit is off or the tool failed) + fire PostToolUse. */
  private async runAndCommit(tool: ToolDef, args: any, cb: Callbacks): Promise<ToolResult> {
    let result: ToolResult;
    try {
      result = await tool.run(args, this.abortController?.signal, this.toolCtx());
    } catch (e) {
      return { output: `${tool.name}: ${(e as Error).message}`, isError: true };
    }
    if (!result.isError && (tool.name === "write" || tool.name === "edit")) {
      this.editedThisTurn = true; // arm the auto lint/test loop
      const abs = path.resolve(this.cwd, String(args.path ?? ""));
      // Capture the pre-turn HEAD before the first edit's commit, for the verifier's diff.
      if (this.turnBaseSha === undefined) this.turnBaseSha = await gitHead(this.cwd);
      this.turnEditedFiles.add(abs);
      // Dom just wrote the file — treat that as having "read" the current content,
      // so consecutive edits work and only EXTERNAL changes force a re-read.
      await this.recordRead(String(args.path ?? ""));
      if (this.autoCommit) {
        await autoCommitFile(abs, tool.name).catch(() => {});
      }
    }
    await this.postHook(tool.name, args, result, cb);
    return result;
  }

  /** `!command` — run bash directly, bypassing the model but not the gate. */
  async runBashDirect(command: string, cb: Callbacks): Promise<void> {
    const tool = TOOLS["bash"]!;
    const args = { command };
    const decision = gate(tool, args, { mode: this.mode, approvals: this.approvals, cwd: this.cwd });
    if (decision.kind === "reject") {
      cb.onSystem(decision.reason);
      return;
    }
    const call: ToolCall = { id: "!", name: "bash", args: JSON.stringify(args) };
    cb.onToolStart(call, args);
    if (decision.kind === "prompt") {
      const ans = await cb.requestPermission(buildBashPreview(this.cwd, command, decision.reason));
      if (ans === "no") {
        cb.onSystem("✗ denied by user");
        return;
      }
      if (ans === "always" && !decision.dangerous) this.approvals.add(approvalKey(tool, args));
    }
    // A direct `!` command is its own one-shot turn, so it needs its own abort
    // controller — otherwise engine.abort() (Ctrl+C) has nothing to signal and
    // the spawned process runs on untouched.
    this.abortController = new AbortController();
    try {
      const res = await runBash(args, this.abortController.signal, this.toolCtx());
      cb.onToolResult(call, res);
    } finally {
      this.abortController = null;
    }
  }
}

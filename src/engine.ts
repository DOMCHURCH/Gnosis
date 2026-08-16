// The agent engine: UI-agnostic. Drives the stream→tool loop and is wired to
// either the headless runner or the Ink UI via a Callbacks object.

import path from "node:path";
import { promises as fs } from "node:fs";
import { serialize, estimateTokens, type Msg, type ToolCall } from "./messages.js";
import { withWorkingDir } from "./system-prompt.js";
import { autoCommitFile } from "./autocommit.js";
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
import { TOOLS, TOOL_NAMES, toolDefinitions, type ToolDef, type ToolResult, type ToolContext } from "./tools/index.js";
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
import { createSession, saveSession, type CostState, type Mode, type SessionData } from "./config.js";
import type { LoadedSkill } from "./skills.js";

const MAX_ITER = 100;

// Plan mode has teeth: these tools are absent from the tool list entirely, so the
// model can't write, run shell commands, or hand work to other tabs — it can only
// read/search/fetch to research, then produce a written plan. Leaves {read, glob,
// grep, http}.
const PLAN_EXCLUDED = new Set(["write", "edit", "bash", "send_message", "list_tabs"]);

const PLAN_DIRECTIVE =
  "\n\nYou are in PLAN MODE. You have only read-only tools (read, glob, grep, http) — " +
  "write, edit, and bash are unavailable. Research as needed, then produce a clear, concrete written plan of the " +
  "changes you would make (files to touch and what to change in each), and STOP. Do not claim you edited anything. " +
  "The user will run /approve to execute the plan, or /revise to amend it.";

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
}

export class Engine {
  private apiKey: string;
  /** Working root for this tab. Mutable so /vault can move a single tab's root;
   * process.cwd() is set to the active tab's cwd on switch. */
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
  mode: Mode;
  summary: string | null;
  cost: CostState;
  approvals = new Set<string>();
  /** Set true only by the interactive TUI; enables the file-edit diff prompt. */
  interactive = false;
  /** Session flag: 'always' (or the input-bar auto mode) auto-approves write/edit diffs. */
  autoApproveEdits = false;
  /** Multi-tab runtime access for the send_message/list_tabs tools; set by the
   * tabs controller. Undefined in single-tab/headless — those tools then no-op. */
  toolContext?: ToolContext;

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

  constructor(deps: EngineDeps) {
    this.apiKey = deps.apiKey;
    this.cwd = deps.cwd;
    this.systemPrompt = deps.systemPrompt;
    this.models = deps.models;
    this.session = deps.session;
    this.skills = deps.skills ?? [];
    this.fallbackModel = deps.fallbackModel;
    this.autoCommit = deps.autoCommit ?? true;
    this.messages = deps.session.messages;
    this.modelId = deps.session.model;
    this.mode = deps.session.mode;
    this.summary = deps.session.summary;
    this.cost = deps.session.cost;
    this.cost.cachedPromptTokens ??= 0; // older sessions predate the cached-token field
  }

  // --- state helpers -------------------------------------------------------

  currentModel(): ModelInfo | undefined {
    return this.models.find((m) => m.id === this.modelId);
  }
  /** True when the active model's provider accepts explicit cache_control
   * breakpoints (a non-zero cache-write price in the catalog). */
  supportsCache(): boolean {
    return (this.currentModel()?.pricing.cacheWrite ?? 0) > 0;
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
    return this.mode === "plan" ? TOOL_NAMES.filter((n) => !PLAN_EXCLUDED.has(n)) : TOOL_NAMES;
  }

  /** System prompt for the current turn, with the stated working directory
   * tracking process.cwd() (so it matches where tools actually run after /vault).
   * In plan mode a directive is appended telling the model to plan, not act. */
  currentSystemPrompt(): string {
    const base = withWorkingDir(this.systemPrompt, process.cwd());
    return this.mode === "plan" ? base + PLAN_DIRECTIVE : base;
  }

  setModel(id: string): void {
    this.modelId = id;
    this.lastPromptTokens = 0;
  }
  setMode(mode: Mode): void {
    this.mode = mode;
  }
  clear(): void {
    this.messages.length = 0;
    this.summary = null;
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
    });
    engine.interactive = this.interactive;
    return engine;
  }

  async persist(): Promise<void> {
    this.session.messages = this.messages;
    this.session.model = this.modelId;
    this.session.mode = this.mode;
    this.session.summary = this.summary;
    this.session.cost = this.cost;
    await saveSession(this.session);
  }

  // --- cost ----------------------------------------------------------------

  private applyUsage(usage: Usage): void {
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
    this.cost.usd += dollars > 0 ? dollars : 0;
    if (usage.prompt_tokens > 0) this.lastPromptTokens = usage.prompt_tokens;
  }

  // --- the loop ------------------------------------------------------------

  async run(userText: string, cb: Callbacks): Promise<void> {
    this.messages.push({ role: "user", text: userText });
    this.abortController = new AbortController();
    this.repairs.clear();
    this.rejections.clear();
    this.stopTurn = false;
    this.sizeRetried = false;

    let iter = 0;
    try {
      for (; iter < MAX_ITER; iter++) {
        if (shouldCompact(this.messages, this.contextTokens(), this.contextLength())) {
          this.doCompact(cb);
        }

        const wire = serialize(this.messages, this.currentSystemPrompt(), this.summary);
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

        this.applyUsage(result.usage);
        const assistant: Extract<Msg, { role: "assistant" }> = {
          role: "assistant",
          text: result.text || undefined,
          calls: result.toolCalls.length ? result.toolCalls : undefined,
        };
        this.messages.push(assistant);
        // The response text is already in the transcript line-by-line; onAssistant
        // only marks completion. History keeps the model's original text.
        cb.onAssistant(assistant);

        if (!result.toolCalls.length) break;

        let stop = false;
        for (const call of result.toolCalls) {
          if (this.abortController.signal.aborted) {
            this.messages.push({ role: "tool", callId: call.id, name: call.name, result: "■ aborted", isError: true });
            stop = true;
            break;
          }
          const res = await this.gateAndExecute(call, cb);
          this.messages.push({ role: "tool", callId: call.id, name: call.name, result: res.output, isError: res.isError });
          cb.onToolResult(call, res);
          if (this.stopTurn) {
            stop = true;
            break;
          }
        }
        if (stop) break;
      }
      if (iter >= MAX_ITER) cb.onSystem("✗ hit 100-iteration cap for this turn");
    } finally {
      this.abortController = null;
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
    const key = rejectionKey(tool, args);
    const label = targetLabel(tool, args);
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

  private async gateAndExecute(call: ToolCall, cb: Callbacks): Promise<ToolResult> {
    const tool = TOOLS[call.name];
    if (!tool) return { output: `unknown tool: ${call.name}`, isError: true };
    // Belt-and-braces: the tool isn't even advertised in this mode, but if the model
    // hallucinates one anyway, refuse it here too (plan mode has no write/edit/bash).
    if (!this.availableToolNames().includes(call.name)) {
      return { output: `${call.name} is not available in ${this.mode} mode`, isError: true };
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
    const decision = gate(tool, args, { mode: this.mode, approvals: this.approvals });
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
          : buildBashPreview(String(args.command ?? ""), decision.reason);
      const ans = await cb.requestPermission(preview);
      if (ans === "no") return this.rejectionResult(tool, args, cb);
      if (ans === "always" && !decision.dangerous) this.approvals.add(approvalKey(tool, args));
    }

    let result: ToolResult;
    try {
      result = await tool.run(args, this.abortController?.signal, this.toolContext);
    } catch (e) {
      return { output: `${tool.name}: ${(e as Error).message}`, isError: true };
    }
    // Reading a file records its mtime, so a later edit can require the model to
    // have seen the current content (see precheckStale).
    if (tool.name === "read" && !result.isError) await this.recordRead(String(args.path ?? ""));
    return result;
  }

  /** Record that a file was read this session, at its current mtime. */
  private async recordRead(p: string): Promise<void> {
    try {
      const abs = path.resolve(process.cwd(), p);
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
    const abs = path.resolve(process.cwd(), String(args.path ?? ""));
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
      return this.runAndCommit(tool, args);
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
    const plan = tool.name === "write" ? await planWrite(args) : await planEdit(args);
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
    return this.runAndCommit(tool, args);
  }

  /** Run a file tool and, on success, auto-commit the file it touched (write/edit
   * only; no-op when autoCommit is off or the tool failed). */
  private async runAndCommit(tool: ToolDef, args: any): Promise<ToolResult> {
    let result: ToolResult;
    try {
      result = await tool.run(args, this.abortController?.signal, this.toolContext);
    } catch (e) {
      return { output: `${tool.name}: ${(e as Error).message}`, isError: true };
    }
    if (!result.isError && (tool.name === "write" || tool.name === "edit")) {
      // Dom just wrote the file — treat that as having "read" the current content,
      // so consecutive edits work and only EXTERNAL changes force a re-read.
      await this.recordRead(String(args.path ?? ""));
      if (this.autoCommit) {
        const abs = path.resolve(process.cwd(), String(args.path ?? ""));
        await autoCommitFile(abs, tool.name).catch(() => {});
      }
    }
    return result;
  }

  /** `!command` — run bash directly, bypassing the model but not the gate. */
  async runBashDirect(command: string, cb: Callbacks): Promise<void> {
    const tool = TOOLS["bash"]!;
    const args = { command };
    const decision = gate(tool, args, { mode: this.mode, approvals: this.approvals });
    if (decision.kind === "reject") {
      cb.onSystem(decision.reason);
      return;
    }
    const call: ToolCall = { id: "!", name: "bash", args: JSON.stringify(args) };
    cb.onToolStart(call, args);
    if (decision.kind === "prompt") {
      const ans = await cb.requestPermission(buildBashPreview(command, decision.reason));
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
      const res = await runBash(args, this.abortController.signal);
      cb.onToolResult(call, res);
    } finally {
      this.abortController = null;
    }
  }
}

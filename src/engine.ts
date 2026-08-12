// The agent engine: UI-agnostic. Drives the stream→tool loop and is wired to
// either the headless runner or the Ink UI via a Callbacks object.

import { serialize, estimateTokens, type Msg, type ToolCall } from "./messages.js";
import { withWorkingDir } from "./system-prompt.js";
import { streamCompletion, ProviderError, type ModelInfo, type Usage } from "./provider.js";
import { TOOLS, toolDefinitions, type ToolDef, type ToolResult } from "./tools/index.js";
import { toJsonSchema } from "./tools/schemas.js";
import { runBash } from "./tools/bash.js";
import { planWrite } from "./tools/write.js";
import { planEdit } from "./tools/edit.js";
import {
  gate,
  approvalKey,
  buildBashPreview,
  buildDiffPreview,
  type GateDecision,
  type Preview,
  type PermissionAnswer,
} from "./permissions.js";
import { shouldCompact, compact } from "./compaction.js";
import { MarkdownStripper, type StreamLine } from "./strip.js";
import { saveSession, type CostState, type Mode, type SessionData } from "./config.js";
import type { LoadedSkill } from "./skills.js";

const MAX_ITER = 100;

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
}

export class Engine {
  private apiKey: string;
  readonly cwd: string;
  private systemPrompt: string;
  models: ModelInfo[];
  private session: SessionData;
  /** Loaded skills (what /skills lists); advertised in the system prompt. */
  readonly skills: LoadedSkill[];

  messages: Msg[];
  modelId: string;
  mode: Mode;
  summary: string | null;
  cost: CostState;
  approvals = new Set<string>();
  /** Set true only by the interactive TUI; enables the file-edit diff prompt. */
  interactive = false;
  /** Session flag: 'always' (or the input-bar auto mode) auto-approves write/edit diffs. */
  autoApproveEdits = false;

  lastPromptTokens = 0;
  private abortController: AbortController | null = null;
  private repairs = new Map<string, number>();
  private surfaceRepair = false;

  constructor(deps: EngineDeps) {
    this.apiKey = deps.apiKey;
    this.cwd = deps.cwd;
    this.systemPrompt = deps.systemPrompt;
    this.models = deps.models;
    this.session = deps.session;
    this.skills = deps.skills ?? [];
    this.messages = deps.session.messages;
    this.modelId = deps.session.model;
    this.mode = deps.session.mode;
    this.summary = deps.session.summary;
    this.cost = deps.session.cost;
  }

  // --- state helpers -------------------------------------------------------

  currentModel(): ModelInfo | undefined {
    return this.models.find((m) => m.id === this.modelId);
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

  /** System prompt for the current turn, with the stated working directory
   * tracking process.cwd() (so it matches where tools actually run after /vault). */
  currentSystemPrompt(): string {
    return withWorkingDir(this.systemPrompt, process.cwd());
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
    this.lastPromptTokens = 0;
    this.repairs.clear();
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
    this.surfaceRepair = false;

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
              tools: toolDefinitions(),
              signal: this.abortController.signal,
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
          } else if (e instanceof ProviderError) {
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
          if (this.surfaceRepair) {
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
      this.surfaceRepair = true;
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

  private async gateAndExecute(call: ToolCall, cb: Callbacks): Promise<ToolResult> {
    const tool = TOOLS[call.name];
    if (!tool) return { output: `unknown tool: ${call.name}`, isError: true };

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

    // File edits get a unified-diff preview + confirm before applying.
    if (tool.name === "write" || tool.name === "edit") {
      return this.gatedFileEdit(tool, args, call, cb, decision);
    }

    cb.onToolStart(call, args);
    if (decision.kind === "prompt") {
      const ans = await cb.requestPermission(buildBashPreview(String(args.command ?? ""), decision.reason));
      if (ans === "no") return { output: "✗ denied by user", isError: true };
      if (ans === "always" && !decision.dangerous) this.approvals.add(approvalKey(tool, args));
    }

    try {
      return await tool.run(args, this.abortController?.signal);
    } catch (e) {
      return { output: `${tool.name}: ${(e as Error).message}`, isError: true };
    }
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
      try {
        return await tool.run(args, this.abortController?.signal);
      } catch (e) {
        return { output: `${tool.name}: ${(e as Error).message}`, isError: true };
      }
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
    if (ans === "no") {
      const verb = tool.name === "edit" ? "edit" : "write";
      return { output: `User rejected the ${verb} to ${plan.relPath}. No changes were made.`, isError: true };
    }
    // 'always' opts the session into auto-accepting edits — but never for a
    // dangerous target, which must keep prompting every time.
    if (ans === "always" && !forcePrompt) this.autoApproveEdits = true;
    try {
      return await tool.run(args, this.abortController?.signal);
    } catch (e) {
      return { output: `${tool.name}: ${(e as Error).message}`, isError: true };
    }
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

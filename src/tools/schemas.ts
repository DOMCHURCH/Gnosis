// Zod schemas are the source of truth. JSON Schema (for the API) and TS types
// are both derived from them — no `any` on the tool boundary.

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export const readSchema = z.object({
  path: z.string().describe("File path to read (absolute or relative to the working directory)."),
  offset: z.number().int().positive().optional().describe("1-based line number to start from."),
  limit: z.number().int().positive().optional().describe("Maximum number of lines to return (default 2000)."),
});

export const writeSchema = z.object({
  path: z.string().describe("File path to create or overwrite."),
  content: z.string().describe("Full file contents to write."),
});

export const editSchema = z.object({
  path: z.string().describe("File to edit."),
  old_str: z
    .string()
    .optional()
    .describe("Single-edit form: exact string to replace. Must be unique unless replace_all is true."),
  new_str: z.string().optional().describe("Single-edit form: the replacement string."),
  replace_all: z
    .boolean()
    .optional()
    .describe("Single-edit form: replace every occurrence instead of requiring a unique match."),
  edits: z
    .array(
      z.object({
        old_str: z.string().describe("Exact string to replace. Must be unique in the file unless replace_all is true."),
        new_str: z.string().describe("Replacement string."),
        replace_all: z.boolean().optional().describe("Replace every occurrence instead of requiring a unique match."),
      }),
    )
    .optional()
    .describe(
      "Batch form (alternative to old_str/new_str): several edits applied to `path` in order, atomically — either " +
        "all apply or none do, and you get ONE permission prompt showing the combined diff. Each edit's uniqueness is " +
        "checked against the file as left by the previous edits.",
    ),
});

export const bashSchema = z.object({
  command: z.string().describe("Shell command to run (POSIX syntax; runs in Git Bash on Windows)."),
  timeout: z.number().int().positive().optional().describe("Timeout in seconds (default 120)."),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Run the command in the background and return immediately with a job id instead of waiting. Use for long-" +
        "running processes (dev servers, watchers, long builds). Check it with /job <id>; stop it with /kill <id>.",
    ),
});

export const globSchema = z.object({
  pattern: z.string().describe("Glob pattern, e.g. '**/*.ts'."),
  path: z.string().optional().describe("Directory to search from (default: working directory)."),
  include_ignored: z
    .boolean()
    .optional()
    .describe(
      "Include files normally skipped: node_modules, dist, build, .next, .git, coverage, .dom, and .gitignore matches.",
    ),
});

export const httpSchema = z.object({
  url: z
    .string()
    .describe("Absolute http(s) URL. Non-http(s) schemes and loopback/private/metadata hosts are blocked."),
  method: z.string().optional().describe("HTTP method: GET (default), POST, PUT, PATCH, DELETE, HEAD."),
  headers: z
    .record(z.string())
    .optional()
    .describe(
      "Request headers as a name→value map. Reference a secret by name as ${VAR_NAME}; the value is read from " +
        "~/.dom/.env at request time and never stored. Authorization/api-key values are shown as <redacted>.",
    ),
  body: z.string().optional().describe("Request body (string). May reference secrets as ${VAR_NAME}."),
  timeout: z.number().int().positive().optional().describe("Timeout in seconds (default 30)."),
});

export const grepSchema = z.object({
  pattern: z.string().describe("Regular expression to search for."),
  path: z.string().optional().describe("File or directory to search (default: working directory)."),
  glob: z.string().optional().describe("Only search files matching this glob."),
  include_ignored: z
    .boolean()
    .optional()
    .describe(
      "Search files normally skipped: node_modules, dist, build, .next, .git, coverage, .dom, and .gitignore matches.",
    ),
});

export const sendMessageSchema = z.object({
  tab: z.string().describe("Name of the target tab to deliver the message to (see list_tabs)."),
  text: z
    .string()
    .describe("Message text. Delivered into the target tab's input as a user message tagged with your tab name."),
});

export const listTabsSchema = z.object({});

export const todoSchema = z.object({
  items: z
    .array(
      z.object({
        text: z.string().describe("Short description of the task (imperative, a few words)."),
        status: z
          .enum(["pending", "active", "done"])
          .describe("pending (not started), active (in progress — keep exactly one), or done (finished)."),
      }),
    )
    .describe(
      "The COMPLETE task list, replacing whatever was there before. Send every task each call with its current " +
        "status — this is the whole list, not a delta.",
    ),
});

export const taskSchema = z.object({
  description: z.string().describe("Short label for the sub-task (3–6 words), shown in the transcript."),
  prompt: z
    .string()
    .optional()
    .describe(
      "The full instruction for the sub-agent: what to find or investigate, and what to report back. Required for a " +
        "single sub-agent; omit (or use as optional framing) when passing `subtasks` for a coordinated task.",
    ),
  coordinate: z
    .boolean()
    .optional()
    .describe(
      "Set true together with `subtasks` to run a COORDINATED task: every subtask spawns its own read-only " +
        "sub-agent in parallel and you (the coordinator) synthesize their summaries into one answer.",
    ),
  tools: z
    .array(z.string())
    .optional()
    .describe(
      "Extra tools to grant this sub-agent beyond the read-only default (read/glob/grep/http). Allowed: " +
        "\"web_search\", \"http\", and any \"mcp__playwright__*\" or \"mcp__context7__*\" tool. Pass this when the " +
        "sub-agent needs to search the web or drive a browser, e.g. tools: [\"web_search\"]. write/edit/bash/" +
        "send_message/list_tabs/task are never granted.",
    ),
  tokenBudget: z
    .number()
    .optional()
    .describe(
      "Token budget for this sub-agent — SIZE IT TO THE TASK. A lookup or a single-file question needs ~8000; " +
        "investigating a subsystem ~30000; designing or drafting a whole component 60000-120000. Defaults to 32000 " +
        "for a single sub-agent and 24000 for each coordinated subtask, and is clamped to [4000, 200000]. A " +
        "sub-agent that returns \"truncated: hit the token cap\" ran out of budget — re-run it with a larger one " +
        "rather than accepting the truncated answer. Pass 0 to request NO limit: that is not yours to grant, so it " +
        "asks the user in the chat first and falls back to the 200000 ceiling if they decline. With `subtasks`, " +
        "this is the default for every subtask; a subtask's own `tokenBudget` overrides it.",
    ),
  subtasks: z
    .array(
      z.object({
        description: z.string().describe("Short label for this sub-agent (3–6 words), shown as a figure on the floor."),
        prompt: z.string().describe("The full, self-contained instruction for this one sub-agent."),
        tokenBudget: z
          .number()
          .optional()
          .describe("Token budget for THIS subtask, overriding the top-level `tokenBudget`. Same rules and limits."),
      }),
    )
    .optional()
    .describe(
      "Coordinated form: a list of independent scoped objectives. Each runs as its own read-only sub-agent IN " +
        "PARALLEL (8 iterations each, and its own token budget — see `tokenBudget`), and only their final summaries " +
        "return to you — their intermediate tool calls never enter your history. Use when a task splits into " +
        "independent areas (different files, topics, or codebases) that can be investigated at the same time. When " +
        "provided, the top-level `prompt` is ignored except as optional framing.",
    ),
});

export const askUserSchema = z.object({
  question: z
    .string()
    .describe("The single, specific question to put to the user. State the decision, not the whole situation."),
  options: z
    .array(z.string())
    .optional()
    .describe(
      "2-5 concrete choices. Omit for an open question — the user always gets a free-text box either way.",
    ),
});

export const viewImageSchema = z.object({
  path: z.string().describe("Path to an image file (png, jpg, jpeg, gif, or webp) to load so you can see it."),
});

export const cameraSchema = z.object({
  reason: z
    .string()
    .optional()
    .describe("What you are looking for in the frame, in a few words (e.g. \"what the user is holding\")."),
});

export const webSearchSchema = z.object({
  query: z.string().describe("The web search query."),
  count: z.number().int().positive().optional().describe("How many results to return (default 8, capped at 20)."),
});

export const oracleSchema = z.object({
  question: z
    .string()
    .describe(
      "A focused, hard sub-problem for a stronger model to reason about. Include ALL needed context inline — the " +
        "oracle runs in an isolated single turn with no tools and no access to your files, history, or the repo.",
    ),
});

export const memorySchema = z.object({
  action: z
    .enum(["add", "list", "clear"])
    .describe("add: append a durable note; list: read the current memory bank; clear: erase it."),
  note: z
    .string()
    .optional()
    .describe("For action=add: the fact to remember (one durable insight — a convention, gotcha, or decision)."),
});

export const officeSchema = z.object({
  action: z
    .enum(["add", "fill", "clear"])
    .describe(
      "add: place `count` agents in one zone; fill: fill a zone (or the whole office when no zone is given) to " +
        "capacity; clear: remove every manually-placed agent from the floor.",
    ),
  zone: z
    .enum(["coordinator", "planning", "application", "coding", "subagents"])
    .optional()
    .describe(
      "Which room to place them in: coordinator (1 desk), planning (2), application (2), coding (8), subagents (6). " +
        "Omit with action=fill to fill every zone; omit with action=add to spread them across the free desks.",
    ),
  mode: z
    .enum(["real", "decorative"])
    .optional()
    .describe(
      "REQUIRED for add/fill, and it is the USER's answer, never your guess. real: open an actual session per " +
        "agent (a /new tab with its own engine and history) and start it on a task. decorative: figures on the " +
        "floor with nothing behind them — visual only. Omit it and the tool places nothing and hands you the " +
        "question to put to the user.",
    ),
  count: z.number().int().positive().optional().describe("For action=add: how many agents to place (default 1)."),
  tasks: z
    .array(z.string())
    .optional()
    .describe(
      "For mode=real only: what each agent starts working on, in placement order — sent as that session's first " +
        "message, so write it as an instruction to a teammate. Ask the user what each zone should work on before " +
        "calling; agents past the end of this list are not opened.",
    ),
  names: z
    .array(z.string())
    .optional()
    .describe(
      "Names for the agents, in placement order. Make them read like real teammates on that floor " +
        '(e.g. "refactor-bot", "test-runner"). Any desk past the end of this list gets an auto-generated name.',
    ),
  state: z
    .enum(["thinking", "awaiting", "speaking", "idle", "mixed"])
    .optional()
    .describe(
      "The state each figure shows: thinking (working), awaiting (blocked on you), speaking (just replied), idle, " +
        "or mixed (default) to vary them across the placed agents.",
    ),
});

export type ReadArgs = z.infer<typeof readSchema>;
export type WriteArgs = z.infer<typeof writeSchema>;
export type EditArgs = z.infer<typeof editSchema>;
export type BashArgs = z.infer<typeof bashSchema>;
export type GlobArgs = z.infer<typeof globSchema>;
export type GrepArgs = z.infer<typeof grepSchema>;
export type HttpArgs = z.infer<typeof httpSchema>;
export type SendMessageArgs = z.infer<typeof sendMessageSchema>;
export type ListTabsArgs = z.infer<typeof listTabsSchema>;
export type TaskArgs = z.infer<typeof taskSchema>;
export type TodoArgs = z.infer<typeof todoSchema>;
export type AskUserArgs = z.infer<typeof askUserSchema>;
export type ViewImageArgs = z.infer<typeof viewImageSchema>;
export type CameraArgs = z.infer<typeof cameraSchema>;
export type WebSearchArgs = z.infer<typeof webSearchSchema>;
export type OracleArgs = z.infer<typeof oracleSchema>;
export type MemoryArgs = z.infer<typeof memorySchema>;
export type OfficeArgs = z.infer<typeof officeSchema>;

export interface ToolJsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

const FORBIDDEN = ["$schema", "$ref", "definitions", "$defs"] as const;

function scrub(node: unknown): void {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  for (const key of FORBIDDEN) delete obj[key];
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) value.forEach(scrub);
    else scrub(value);
  }
}

/**
 * Convert a zod schema into a JSON Schema that satisfies Anthropic's draft
 * 2020-12 validation (via OpenRouter). Anthropic rejects `$ref`/`definitions`
 * and draft-04 constructs, so we:
 *  - derive with target "jsonSchema7" and $refStrategy "none" (numeric
 *    exclusiveMinimum, no refs/definitions),
 *  - strip $schema/$ref/definitions/$defs everywhere,
 *  - return exactly { type, properties, required, additionalProperties: false }.
 * Tool args are flat primitives / optional strings only — no union/record/lazy.
 */
export function toJsonSchema(schema: z.ZodTypeAny): ToolJsonSchema {
  const js = zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7" }) as Record<string, unknown>;
  const properties = (js.properties as Record<string, unknown>) ?? {};
  const required = Array.isArray(js.required) ? (js.required as string[]) : [];
  scrub(properties);
  return { type: "object", properties, required, additionalProperties: false };
}

/** focus_window: bring another application to the foreground, or list what is open. */
export const focusWindowSchema = z.object({
  action: z.enum(["focus", "list"]).describe("focus a window, or list the open ones"),
  app: z.string().optional().describe("process name or window-title substring, e.g. \"chrome\", \"code\""),
  pid: z.number().optional().describe("exact process id, when you already have one from action=list"),
});
export type FocusWindowArgs = z.infer<typeof focusWindowSchema>;

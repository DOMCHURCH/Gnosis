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
  prompt: z.string().describe("The full instruction for the sub-agent: what to find or investigate, and what to report back."),
});

export const viewImageSchema = z.object({
  path: z.string().describe("Path to an image file (png, jpg, jpeg, gif, or webp) to load so you can see it."),
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
export type ViewImageArgs = z.infer<typeof viewImageSchema>;
export type WebSearchArgs = z.infer<typeof webSearchSchema>;
export type OracleArgs = z.infer<typeof oracleSchema>;
export type MemoryArgs = z.infer<typeof memorySchema>;

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

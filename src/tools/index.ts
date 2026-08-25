import type { z } from "zod";
import type { ToolSchema } from "../provider.js";
import type { TodoItem } from "../config.js";
import type { ImagePart } from "../messages.js";
import {
  bashSchema,
  editSchema,
  globSchema,
  grepSchema,
  httpSchema,
  listTabsSchema,
  readSchema,
  sendMessageSchema,
  oracleSchema,
  memorySchema,
  taskSchema,
  todoSchema,
  viewImageSchema,
  askUserSchema,
  webSearchSchema,
  toJsonSchema,
  writeSchema,
} from "./schemas.js";
import { runRead } from "./read.js";
import { runWrite } from "./write.js";
import { runEdit } from "./edit.js";
import { runBash } from "./bash.js";
import { runGlob } from "./glob.js";
import { runGrep } from "./grep.js";
import { runHttp } from "./http.js";
import { runSendMessage, runListTabs } from "./tabs.js";
import { runTask } from "./task.js";
import { runTodo } from "./todo.js";
import { runViewImage } from "./viewimage.js";
import { runWebSearch } from "./websearch.js";
import { runOracle } from "./oracle.js";
import { runMemory } from "./memory.js";
import { runAskUser } from "./askuser.js";

/** Progressive-write channel for the edit tool. Set by the engine (after the
 * permission gate passes) only for streamable edits; absent → atomic write. The
 * engine forwards these onto the event bus (edit.start/line/commit) and shows a
 * live char count in the TUI. The tool still writes to disk exactly once, at the
 * moment it calls commit(). */
export interface EditStream {
  start(path: string, original: string, totalLines: number): void;
  line(index: number, text: string, changed: boolean, chars: number): void;
  commit(path: string, ok: boolean, summary: string): void;
}

export interface ToolResult {
  output: string;
  isError: boolean;
  /** Set when the tool was cancelled via the turn's AbortSignal (Ctrl+C) rather
   * than failing on its own — the UI renders this as "aborted", not an error. */
  aborted?: boolean;
}

/** The calling tab's view of the multi-tab runtime — how send_message/list_tabs
 * reach the controller. Bound per tab (selfName is fixed), so it is safe even
 * when several tabs' turns run concurrently. Absent outside the multi-tab TUI. */
export interface TabRuntime {
  selfName(): string;
  /** This tab's numeric id (for placing background-job figures on the web floor). */
  selfId(): number;
  sendMessage(to: string, text: string): { ok: boolean; message: string };
  listTabs(): { name: string; purpose: string; active: boolean; busy: boolean }[];
}

/** Result of a sub-agent run: its final text plus accounting for the transcript. */
export interface SubAgentResult {
  text: string;
  tools: number;
  tokens: number;
  capped: string | null;
}
/** Spawns a read-only sub-agent and returns only its final text (+ accounting). */
export type SubAgentRunner = (description: string, prompt: string, signal?: AbortSignal, tools?: string[]) => Promise<SubAgentResult>;

/** One coordinated sub-agent's scoped objective. */
export interface SubTask {
  description: string;
  prompt: string;
}
/** Result of one coordinated sub-agent (its label + final summary + accounting). */
export interface CoordinatedResult extends SubAgentResult {
  description: string;
}
/** Spawns every subtask as a parallel read-only sub-agent (tight caps) and returns
 * each one's summary in the same order. Refused inside a sub-agent (no recursion). */
export type CoordinateRunner = (subtasks: SubTask[], signal?: AbortSignal, tools?: string[]) => Promise<CoordinatedResult[]>;

/** Result of an oracle consultation: the answer plus accounting. */
export interface OracleResult {
  text: string;
  model: string;
  tokens: number;
  usd: number;
}
/** Runs a single-turn, tool-less completion on the stronger oracle model. */
export type OracleRunner = (question: string, signal?: AbortSignal) => Promise<OracleResult>;

/** How an ask_user question came back: answered, timed out, or aborted (Ctrl+C). */
export interface AskUserAnswer {
  text: string;
  timedOut?: boolean;
  aborted?: boolean;
}
/** Puts a question to whoever is driving (TUI overlay or browser card; first to
 * answer wins) and resolves with their reply. */
export type AskUserRunner = (question: string, options: string[], signal?: AbortSignal) => Promise<AskUserAnswer>;

/** Per-turn context passed to tool.run. Carries the working directory paths are
 * resolved against (each engine owns its own — tabs and sub-agents pass theirs);
 * the multi-tab tools use `tab`; the `task` tool uses `subagent`; the `todo` tool
 * uses `setTodos`; the `view_image` tool uses `imageInput` + `attachImage`. */
export interface ToolContext {
  /** The directory every path-resolving tool resolves against (never process.cwd()). */
  cwd: string;
  /** Workspace roots (roots[0] === cwd). When set with 2+ entries, grep/glob
   * called WITHOUT an explicit path search every root and prefix each result with
   * the root's name. Absent / single-entry → ordinary single-root behavior. */
  roots?: string[];
  tab?: TabRuntime;
  subagent?: SubAgentRunner;
  /** Present only in the top-level agent (never in a sub-agent): run a coordinated
   * set of parallel sub-agents for the `task` tool's `subtasks` form. */
  coordinate?: CoordinateRunner;
  /** Replace the session's task list (rendered live above the input). Absent
   * headless / in sub-agents, where the tool simply returns its summary. */
  setTodos?: (items: TodoItem[]) => void;
  /** Whether the active model accepts image input — view_image refuses if false. */
  imageInput?: boolean;
  /** Attach a loaded image to the next message (view_image). */
  attachImage?: (img: ImagePart) => void;
  /** Consult the stronger oracle model (single turn, no tools) for `oracle`. */
  oracle?: OracleRunner;
  /** Set (post-approval) when a large edit should stream its write line-by-line.
   * Absent → the edit tool writes atomically (small edits, headless, sub-agents). */
  editStream?: EditStream;
  /** Put one question to the user and wait for the answer (`ask_user`). Absent
   * where there is nobody to ask — headless runs and sub-agents — and the tool
   * refuses rather than blocking. */
  askUser?: AskUserRunner;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  /** Mutating tools go through the permission gate; read-only tools run free. */
  mutating: boolean;
  /** `signal` aborts a long-running tool (only bash honours it today); `ctx`
   * carries multi-tab runtime access for send_message/list_tabs. */
  run: (args: any, signal?: AbortSignal, ctx?: ToolContext) => Promise<ToolResult>;
  /** MCP tools carry a raw JSON Schema (used verbatim for the model) instead of a
   * zod schema; `source` marks where the tool came from. */
  jsonSchema?: Record<string, unknown>;
  source?: "builtin" | "mcp";
}

export const TOOLS: Record<string, ToolDef> = {
  read: {
    name: "read",
    description: "Read a file and return its contents with line numbers. Rejects binary files.",
    schema: readSchema,
    mutating: false,
    run: runRead,
  },
  write: {
    name: "write",
    description: "Create or overwrite a file. Creates parent directories as needed.",
    schema: writeSchema,
    mutating: true,
    run: runWrite,
  },
  edit: {
    name: "edit",
    description:
      "Replace exact strings in a file. Single edit: old_str (unique in the file unless replace_all) → new_str. " +
      "Or pass `edits: [{old_str, new_str, replace_all?}]` to apply several edits to the same file atomically — all " +
      "apply or none do, with one confirmation showing the combined diff.",
    schema: editSchema,
    mutating: true,
    run: runEdit,
  },
  bash: {
    name: "bash",
    description: "Run a shell command and return combined stdout/stderr. Default timeout 120s.",
    schema: bashSchema,
    mutating: true,
    run: runBash,
  },
  ask_user: {
    name: "ask_user",
    description:
      "Ask the user one question and wait for their answer. Use this ONLY when the task admits two or more " +
      "equally valid approaches AND choosing wrong would mean significant rework. Never use it for anything you " +
      "can infer from the code, the request, or context. At most one ask per turn — otherwise state your " +
      "assumption and keep going.",
    schema: askUserSchema,
    // Not "mutating": it changes nothing on disk, so it skips the permission gate.
    // Its own prompt IS the confirmation.
    mutating: false,
    run: runAskUser,
  },
  glob: {
    name: "glob",
    description: "Find files matching a glob pattern, returned newest-first by modification time.",
    schema: globSchema,
    mutating: false,
    run: runGlob,
  },
  grep: {
    name: "grep",
    description: "Search file contents with a regular expression (ripgrep when available).",
    schema: grepSchema,
    mutating: false,
    run: runGrep,
  },
  http: {
    name: "http",
    description:
      "Make an HTTP(S) request and return the status, response headers, and body (JSON pretty-printed). " +
      "Only http/https to public hosts — loopback, private, and cloud-metadata addresses are refused. " +
      "Reference secrets by name as ${VAR_NAME} in the url, headers, or body; values come from ~/.dom/.env " +
      "and are never stored. Authorization/api-key headers are shown as <redacted>.",
    schema: httpSchema,
    mutating: true,
    run: runHttp,
  },
  send_message: {
    name: "send_message",
    description:
      "Multi-tab sessions only: deliver a message to another tab (a separate agent) by name. It arrives " +
      "in that tab as a user message tagged with your tab name and triggers a turn there. Use list_tabs " +
      "to see targets. Bounded to prevent loops: max 3 hops, no replying to the tab a message just came " +
      "from in the same turn, and 20 inter-agent messages per session.",
    schema: sendMessageSchema,
    mutating: false,
    run: runSendMessage,
  },
  list_tabs: {
    name: "list_tabs",
    description: "Multi-tab sessions only: list the open tabs (agents) with each one's name and one-line purpose.",
    schema: listTabsSchema,
    mutating: false,
    run: runListTabs,
  },
  task: {
    name: "task",
    description:
      "Delegate an open-ended search or investigation to a fresh read-only sub-agent (\"find where X is handled\", " +
      "\"which files touch Y\"). It has its own context and only read/glob/grep/http — it explores, then returns a " +
      "concise summary as the result. Its intermediate steps never enter your history, so prefer it over grepping " +
      "large amounts of output into your own context. Cannot write, run commands, or spawn further sub-agents. " +
      "For work that splits into independent areas, pass `coordinate: true` with a `subtasks` array: each subtask " +
      "runs as its own sub-agent in parallel and you synthesize all their summaries — faster and lighter on context.",
    schema: taskSchema,
    mutating: false,
    run: runTask,
  },
  todo: {
    name: "todo",
    description:
      "Maintain a visible task list for a multi-step job. Call it with the COMPLETE list each time (every task with " +
      "its status: pending, active, or done) — each call replaces the previous list. Use it for any task that needs " +
      "3+ steps: lay out the plan up front, mark exactly one task active when you start it, and mark it done the " +
      "moment it's finished. It renders above the input so the user can follow along.",
    schema: todoSchema,
    mutating: false,
    run: runTodo,
  },
  view_image: {
    name: "view_image",
    description:
      "Load an image file (png, jpg, jpeg, gif, webp) so you can see it — the image is attached to the next message. " +
      "Only works when the active model accepts image input; otherwise it errors and you should ask the user to " +
      "switch to a vision model.",
    schema: viewImageSchema,
    mutating: false,
    run: runViewImage,
  },
  web_search: {
    name: "web_search",
    description:
      "Search the web via the Brave Search API and return the top results (title, URL, snippet). Use it to find " +
      "current information or the right page, then fetch a specific result with the http tool. Needs BRAVE_API_KEY " +
      "in ~/.dom/.env.",
    schema: webSearchSchema,
    mutating: false,
    run: runWebSearch,
  },
  oracle: {
    name: "oracle",
    description:
      "Consult a stronger model on a hard, self-contained sub-problem (a tricky bug, an algorithm, a design call). " +
      "It runs a single isolated turn with no tools and no access to your files or history, so put ALL needed " +
      "context in the question, and returns just the answer. Use sparingly for genuinely hard problems — it costs " +
      "more (tracked separately in /cost).",
    schema: oracleSchema,
    mutating: false,
    run: runOracle,
  },
  memory: {
    name: "memory",
    description:
      "Durable project memory that persists across sessions and is loaded into your context at the start of each " +
      "one. action=add saves a note (a convention, gotcha, decision, or fact worth remembering next time); " +
      "action=list reads the current bank; action=clear erases it. Save sparingly — only durable insights, not " +
      "transient state. Stored outside the repo (~/.dom/memory), so it never touches the user's tree.",
    schema: memorySchema,
    mutating: false,
    run: runMemory,
  },
};

export const TOOL_NAMES = Object.keys(TOOLS);

// Dynamic MCP tools, published by the MCP manager whenever servers connect,
// disconnect, or toggle. Namespaced mcp__<server>__<tool> so they never collide
// with built-ins. Kept separate from TOOLS (which stays static + immutable).
let MCP_TOOLS: Record<string, ToolDef> = {};
export function setMcpToolDefs(defs: Record<string, ToolDef>): void {
  MCP_TOOLS = defs;
}
export function mcpToolNames(): string[] {
  return Object.keys(MCP_TOOLS);
}
/** Resolve a tool by name across built-ins and connected MCP servers. */
export function resolveTool(name: string): ToolDef | undefined {
  return TOOLS[name] ?? MCP_TOOLS[name];
}
/** All advertised tool names (built-ins + connected MCP tools). */
export function allToolNames(): string[] {
  return [...TOOL_NAMES, ...Object.keys(MCP_TOOLS)];
}

/** The tools array sent to the API. Built-ins derive parameters from their zod
 * schema; MCP tools pass their JSON Schema verbatim. Pass `names` to restrict the
 * set (e.g. plan mode advertises only read-only tools). */
export function toolDefinitions(names?: readonly string[]): ToolSchema[] {
  const list = names
    ? names.map((n) => resolveTool(n)).filter((t): t is ToolDef => !!t)
    : [...Object.values(TOOLS), ...Object.values(MCP_TOOLS)];
  return list.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.jsonSchema ?? toJsonSchema(t.schema),
    },
  }));
}

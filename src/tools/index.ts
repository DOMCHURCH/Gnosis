import type { z } from "zod";
import type { ToolSchema } from "../provider.js";
import {
  bashSchema,
  editSchema,
  globSchema,
  grepSchema,
  httpSchema,
  listTabsSchema,
  readSchema,
  sendMessageSchema,
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
  sendMessage(to: string, text: string): { ok: boolean; message: string };
  listTabs(): { name: string; purpose: string; active: boolean; busy: boolean }[];
}

/** Per-turn context passed to tool.run. Most tools ignore it; the multi-tab
 * tools use `tab`. */
export interface ToolContext {
  tab?: TabRuntime;
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
      "Replace an exact string in a file. old_str must match exactly once unless replace_all is true.",
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
};

export const TOOL_NAMES = Object.keys(TOOLS);

/** The tools array sent to the API, derived from the zod schemas. Pass `names` to
 * restrict the set (e.g. plan mode advertises only read-only tools). */
export function toolDefinitions(names?: readonly string[]): ToolSchema[] {
  const list = names ? names.map((n) => TOOLS[n]).filter((t): t is ToolDef => !!t) : Object.values(TOOLS);
  return list.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: toJsonSchema(t.schema),
    },
  }));
}

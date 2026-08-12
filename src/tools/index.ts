import type { z } from "zod";
import type { ToolSchema } from "../provider.js";
import {
  bashSchema,
  editSchema,
  globSchema,
  grepSchema,
  readSchema,
  toJsonSchema,
  writeSchema,
} from "./schemas.js";
import { runRead } from "./read.js";
import { runWrite } from "./write.js";
import { runEdit } from "./edit.js";
import { runBash } from "./bash.js";
import { runGlob } from "./glob.js";
import { runGrep } from "./grep.js";

export interface ToolResult {
  output: string;
  isError: boolean;
  /** Set when the tool was cancelled via the turn's AbortSignal (Ctrl+C) rather
   * than failing on its own — the UI renders this as "aborted", not an error. */
  aborted?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  /** Mutating tools go through the permission gate; read-only tools run free. */
  mutating: boolean;
  /** `signal` aborts a long-running tool (only bash honours it today). */
  run: (args: any, signal?: AbortSignal) => Promise<ToolResult>;
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
};

export const TOOL_NAMES = Object.keys(TOOLS);

/** The tools array sent to the API, derived from the zod schemas. */
export function toolDefinitions(): ToolSchema[] {
  return Object.values(TOOLS).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: toJsonSchema(t.schema),
    },
  }));
}

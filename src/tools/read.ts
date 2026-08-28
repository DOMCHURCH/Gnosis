import { promises as fs } from "node:fs";
import path from "node:path";
import { truncateOutput } from "./truncate.js";
import type { ReadArgs } from "./schemas.js";
import type { ToolContext, ToolResult } from "./index.js";
import { resolveUserPath } from "../homepath.js";

const DEFAULT_LIMIT = 2000;

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export async function runRead(args: ReadArgs, _signal?: AbortSignal, ctx?: ToolContext): Promise<ToolResult> {
  const abs = resolveUserPath(ctx?.cwd ?? process.cwd(), args.path);
  let buf: Buffer;
  try {
    buf = await fs.readFile(abs);
  } catch (e) {
    return { output: `read: ${(e as Error).message}`, isError: true };
  }
  if (looksBinary(buf)) {
    return { output: `read: refusing to read binary file ${args.path}`, isError: true };
  }

  const allLines = buf.toString("utf8").split("\n");
  const start = args.offset ? args.offset - 1 : 0;
  const limit = args.limit ?? DEFAULT_LIMIT;
  const slice = allLines.slice(start, start + limit);
  const numbered = slice
    .map((l, i) => `${String(start + i + 1).padStart(6)}  ${l}`)
    .join("\n");

  const remaining = allLines.length - (start + slice.length);
  const footer = remaining > 0 ? `\n... (${remaining} more line${remaining === 1 ? "" : "s"})` : "";
  return { output: truncateOutput(numbered + footer), isError: false };
}

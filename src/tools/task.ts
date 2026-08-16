import type { TaskArgs } from "./schemas.js";
import type { ToolContext, ToolResult } from "./index.js";

/**
 * Spawn a read-only sub-agent to investigate an open-ended question and return
 * only its final answer. The heavy lifting (fresh Engine, restricted tools, caps,
 * cost attribution) is done by the parent engine via ctx.subagent — this tool just
 * formats the one-line accounting + summary the transcript shows.
 */
export async function runTask(args: TaskArgs, signal?: AbortSignal, ctx?: ToolContext): Promise<ToolResult> {
  const run = ctx?.subagent;
  if (!run) return { output: "the task tool is not available here", isError: true };
  try {
    const res = await run(args.description, args.prompt, signal);
    const meta =
      `${res.tools} tool${res.tools === 1 ? "" : "s"} · ${res.tokens} tokens` +
      (res.capped ? ` (truncated: hit the ${res.capped} cap)` : "");
    return { output: `${meta}\n${res.text}`, isError: false };
  } catch (e) {
    return { output: `task: ${(e as Error).message}`, isError: true };
  }
}

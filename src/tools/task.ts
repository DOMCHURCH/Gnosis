import type { TaskArgs } from "./schemas.js";
import type { ToolContext, ToolResult } from "./index.js";

/**
 * Delegate to sub-agent(s) and return only their final answer(s).
 *
 * Two forms:
 *  - `prompt` — ONE read-only sub-agent investigates and reports back.
 *  - `subtasks` — a COORDINATED task: every subtask spawns its own read-only
 *    sub-agent, they run in parallel, and this tool returns all their summaries
 *    in one result for the caller (the coordinator) to synthesize.
 *
 * The heavy lifting (fresh Engines, restricted tools, per-sub-agent caps, cost
 * attribution) is done by the parent engine via ctx.subagent / ctx.coordinate —
 * this tool only formats the accounting + summaries the transcript shows.
 */
export async function runTask(args: TaskArgs, signal?: AbortSignal, ctx?: ToolContext): Promise<ToolResult> {
  const subtasks = args.subtasks ?? [];
  if (subtasks.length) return runCoordinated(args, subtasks, signal, ctx);

  const run = ctx?.subagent;
  if (!run) return { output: "the task tool is not available here", isError: true };
  try {
    const res = await run(args.description, args.prompt ?? "", signal);
    const meta =
      `${res.tools} tool${res.tools === 1 ? "" : "s"} · ${res.tokens} tokens` +
      (res.capped ? ` (truncated: hit the ${res.capped} cap)` : "");
    return { output: `${meta}\n${res.text}`, isError: false };
  } catch (e) {
    return { output: `task: ${(e as Error).message}`, isError: true };
  }
}

/**
 * The coordinated form. Each summary is returned under its own numbered heading
 * so the coordinator can attribute findings; the header line carries the fan-out
 * width and the combined accounting.
 */
async function runCoordinated(
  args: TaskArgs,
  subtasks: { description: string; prompt: string }[],
  signal?: AbortSignal,
  ctx?: ToolContext,
): Promise<ToolResult> {
  const run = ctx?.coordinate;
  if (!run) return { output: "coordinated tasks are not available here", isError: true };
  try {
    const res = await run(args.description, subtasks, signal);
    const tools = res.results.reduce((n, r) => n + r.tools, 0);
    const tokens = res.results.reduce((n, r) => n + r.tokens, 0);
    const head =
      `coordinated: ${res.results.length} sub-agent${res.results.length === 1 ? "" : "s"} in parallel · ` +
      `${tools} tool${tools === 1 ? "" : "s"} · ${tokens} tokens`;
    const bodies = res.results.map((r, i) => {
      const capped = r.capped ? ` (truncated: hit the ${r.capped} cap)` : "";
      return `[${i + 1}] ${r.description} — ${r.label}${capped}\n${r.text}`;
    });
    return {
      output:
        `${head}\n\n${bodies.join("\n\n")}\n\n` +
        `Synthesize these ${res.results.length} findings into one answer for the user — do not re-run this search.`,
      isError: false,
    };
  } catch (e) {
    return { output: `task: ${(e as Error).message}`, isError: true };
  }
}

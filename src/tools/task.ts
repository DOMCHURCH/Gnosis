import type { TaskArgs } from "./schemas.js";
import type { ToolContext, ToolResult } from "./index.js";

/**
 * Spawn a read-only sub-agent to investigate an open-ended question and return
 * only its final answer. The heavy lifting (fresh Engine, restricted tools, caps,
 * cost attribution) is done by the parent engine via ctx.subagent — this tool just
 * formats the one-line accounting + summary the transcript shows.
 *
 * Coordinated form: when `subtasks` is provided, each subtask spawns its own
 * read-only sub-agent IN PARALLEL (via ctx.coordinate). Only their final summaries
 * come back here; the coordinator (the model calling this tool) then synthesizes
 * them into the answer the user sees.
 */
export async function runTask(args: TaskArgs, signal?: AbortSignal, ctx?: ToolContext): Promise<ToolResult> {
  const subtasks = args.subtasks;
  if (subtasks && subtasks.length > 0) {
    // A sub-agent has no `coordinate` runner — enforces "sub-agents cannot spawn
    // further sub-agents", including the coordinated form.
    const coordinate = ctx?.coordinate;
    if (!coordinate) {
      return { output: "task: coordinated sub-tasks can only be launched by the top-level agent, not from within a sub-agent.", isError: true };
    }
    try {
      const results = await coordinate(subtasks, signal, { tools: args.tools, tokenBudget: args.tokenBudget });
      const totalTools = results.reduce((n, r) => n + r.tools, 0);
      const totalTokens = results.reduce((n, r) => n + r.tokens, 0);
      const header = `${results.length} sub-agents · ${totalTools} tool${totalTools === 1 ? "" : "s"} · ${totalTokens} tokens`;
      // Each sub-agent's scoped summary, labelled, for the coordinator to synthesize.
      const body = results
        .map((r, i) => `── sub-agent ${i + 1}: ${r.description}${r.capped ? ` (truncated: hit the ${r.capped} cap — re-run this subtask with a larger \`tokenBudget\`)` : ""} ──\n${r.text}`)
        .join("\n\n");
      return { output: `${header}\n\n${body}`, isError: false };
    } catch (e) {
      return { output: `task: ${(e as Error).message}`, isError: true };
    }
  }

  const run = ctx?.subagent;
  if (!run) return { output: "the task tool is not available here", isError: true };
  if (!args.prompt) return { output: "task: provide `prompt` for a single sub-agent, or `subtasks` for a coordinated task.", isError: true };
  try {
    const res = await run(args.description, args.prompt, signal, { tools: args.tools, tokenBudget: args.tokenBudget });
    const meta =
      `${res.tools} tool${res.tools === 1 ? "" : "s"} · ${res.tokens} tokens` +
      (res.capped ? ` (truncated: hit the ${res.capped} cap — re-run with a larger \`tokenBudget\`, or tokenBudget: 0 to ask the user to remove the limit)` : "");
    return { output: `${meta}\n${res.text}`, isError: false };
  } catch (e) {
    return { output: `task: ${(e as Error).message}`, isError: true };
  }
}

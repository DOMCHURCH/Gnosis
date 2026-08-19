import type { TodoArgs } from "./schemas.js";
import type { ToolContext, ToolResult } from "./index.js";

/**
 * The model's task list. Each call REPLACES the whole list; the engine stores it
 * on the session (persisted, per-tab) and the UI renders it live in the dynamic
 * region above the input. Read-only with respect to the filesystem, so it runs
 * without a permission prompt. Outside the interactive UI (headless / no context)
 * it still returns its summary so the model can keep tracking.
 */
export async function runTodo(args: TodoArgs, _signal?: AbortSignal, ctx?: ToolContext): Promise<ToolResult> {
  const items = args.items.map((i) => ({ text: i.text, status: i.status }));
  ctx?.setTodos?.(items);
  const counts = { pending: 0, active: 0, done: 0 };
  for (const i of items) counts[i.status]++;
  const n = items.length;
  const summary =
    n === 0
      ? "todo: list cleared"
      : `todo: ${n} task${n === 1 ? "" : "s"} — ${counts.done} done, ${counts.active} active, ${counts.pending} pending`;
  return { output: summary, isError: false };
}

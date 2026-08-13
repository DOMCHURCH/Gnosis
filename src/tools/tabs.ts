// The multi-tab tools: send_message (deliver to another tab) and list_tabs.
// Both are thin wrappers over the per-tab TabRuntime handed in via ToolContext;
// all the routing, loop-prevention, and dispatch live in src/tabs.ts. Outside
// the multi-tab TUI there is no runtime, so they report that and no-op.

import type { SendMessageArgs, ListTabsArgs } from "./schemas.js";
import type { ToolResult, ToolContext } from "./index.js";

export async function runSendMessage(
  args: SendMessageArgs,
  _signal?: AbortSignal,
  ctx?: ToolContext,
): Promise<ToolResult> {
  if (!ctx?.tab) {
    return { output: "send_message is only available in dom's multi-tab TUI (create tabs with /new).", isError: true };
  }
  const r = ctx.tab.sendMessage(args.tab, args.text);
  return { output: r.message, isError: !r.ok };
}

export async function runListTabs(
  _args: ListTabsArgs,
  _signal?: AbortSignal,
  ctx?: ToolContext,
): Promise<ToolResult> {
  if (!ctx?.tab) {
    return { output: "list_tabs is only available in dom's multi-tab TUI.", isError: true };
  }
  const tabs = ctx.tab.listTabs();
  if (!tabs.length) return { output: "(no tabs)", isError: false };
  const rows = tabs.map(
    (t) =>
      `- ${t.name}${t.active ? " (active)" : ""}${t.busy ? " [busy]" : ""} — ${t.purpose || "(no purpose set)"}`,
  );
  return { output: rows.join("\n"), isError: false };
}

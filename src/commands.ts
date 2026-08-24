// The one canonical list of in-session slash commands. The TUI's /help renders
// from this, and `dom serve` sends it to the browser so its autocomplete shows the
// SAME commands — no second hardcoded list.

export interface CommandDef {
  /** e.g. "/model" */
  name: string;
  /** short usage/args hint shown after the name, e.g. "[id]" */
  args?: string;
  desc: string;
}

export const COMMANDS: CommandDef[] = [
  { name: "/model", args: "[id]", desc: "switch model (no arg opens the picker)" },
  { name: "/mode", args: "<ask|plan|yolo>", desc: "change permission mode" },
  { name: "/approve", desc: "(plan mode) switch to ask and execute the written plan" },
  { name: "/revise", args: "<text>", desc: "(plan mode) amend the plan without executing" },
  { name: "/new", args: "[name] [purpose]", desc: "open a new tab (its own history + engine)" },
  { name: "/tabs", desc: "list open tabs" },
  { name: "/tab", args: "<n|name>", desc: "switch tabs" },
  { name: "/close", desc: "close the active tab" },
  { name: "/alltabs", desc: "tiled read-only overview of every tab" },
  { name: "/worktree", args: "<name|list|merge|remove>", desc: "isolate work in a git worktree + tab" },
  { name: "/workspace", args: "<add|list|remove>", desc: "manage search roots (grep/glob span all)" },
  { name: "/memory", args: "[add <note>|show|stats|clear]", desc: "project memory bank + automatic learned context" },
  { name: "/schedule", args: "[add <spec> | <prompt>|remove <id>]", desc: "scheduled runs" },
  { name: "/skills", desc: "list loaded skills" },
  { name: "/clear", desc: "clear the conversation" },
  { name: "/compact", desc: "summarize and shrink history" },
  { name: "/tools", desc: "list available tools" },
  { name: "/cost", desc: "show token + dollar usage" },
  { name: "/budget", args: "[usd]", desc: "show or set the session dollar ceiling" },
  { name: "/context", desc: "what fills the context window, by category" },
  { name: "/verify", desc: "skeptically verify the last change (diff vs request)" },
  { name: "/trace", desc: "summarize this session's trajectory trace" },
  { name: "/verbose", desc: "toggle full (unsummarized) tool output" },
  { name: "/resume", desc: "pick a prior session for this directory" },
  { name: "/vault", args: "[set <path>]", desc: "switch working root to your Obsidian vault" },
  { name: "/undo", desc: "revert dom's most recent commit (or checkpointed edit)" },
  { name: "/checkpoints", desc: "list recent dom checkpoints" },
  { name: "/jobs", desc: "list background jobs" },
  { name: "/job", args: "<id>", desc: "show a background job's output" },
  { name: "/kill", args: "<id>", desc: "stop a background job" },
  { name: "/serve", args: "[stop] [--port <n>] [--public] [--lan]", desc: "start/stop the web view (--public: tunnel, --lan: same-WiFi QR; all with QR codes)" },
  { name: "/webhooks", args: "[clear]", desc: "list webhooks captured this session (inspector lives in the WEBHOOKS tab)" },
  { name: "/design", args: "[url|port|off]", desc: "screenshot the dev server, see it, and auto-capture before/after on web edits" },
  { name: "/hooks", desc: "list registered lifecycle hooks" },
  { name: "/init", args: "[--force]", desc: "scan the repo and write an AGENTS.md" },
  { name: "/map", desc: "print the repo map and its token count" },
  { name: "/help", desc: "this help" },
  { name: "/exit", desc: "quit" },
];

/** The /help text (TUI), rendered from the same registry. */
export function helpText(): string {
  const rows = COMMANDS.map((c) => `  ${c.name}${c.args ? " " + c.args : ""}   ${c.desc}`);
  return [
    "commands:",
    ...rows,
    "  @  insert a file path    !cmd  run a shell command    ctrl+r  search prompt history",
    "  ctrl+1..9  best-effort tab-switch alias for /tab (some terminals don't send it)",
  ].join("\n");
}

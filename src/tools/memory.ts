import type { MemoryArgs } from "./schemas.js";
import type { ToolContext, ToolResult } from "./index.js";
import { appendMemory, readMemory, clearMemory, countEntries } from "../memory.js";

/**
 * The memory bank: durable, project-scoped notes the model saves for future
 * sessions. `add` appends a note, `list` reads the current bank, `clear` erases
 * it. The bank is injected into the system prompt at the start of every session,
 * so anything saved here is remembered next time. Filesystem-safe and stored
 * under ~/.dom/memory (never in the repo), so it runs without a permission prompt.
 */
export async function runMemory(args: MemoryArgs, _signal?: AbortSignal, ctx?: ToolContext): Promise<ToolResult> {
  const cwd = ctx?.cwd ?? process.cwd();
  switch (args.action) {
    case "add": {
      const note = (args.note ?? "").trim();
      if (!note) return { output: "memory: nothing to add — pass `note` with the fact to remember.", isError: true };
      const count = await appendMemory(cwd, note);
      return { output: `memory: saved (${count} note${count === 1 ? "" : "s"} in this project's bank).`, isError: false };
    }
    case "list": {
      const content = await readMemory(cwd);
      if (!content) return { output: "memory: the bank is empty for this project.", isError: false };
      return { output: `memory (${countEntries(content)} notes):\n${content}`, isError: false };
    }
    case "clear": {
      await clearMemory(cwd);
      return { output: "memory: bank cleared for this project.", isError: false };
    }
  }
}

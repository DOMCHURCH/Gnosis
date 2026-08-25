// ask_user — the agent pauses mid-turn and puts one question to the person driving
// it. Deliberately thin: the tool owns no UI. It calls ctx.askUser, which the engine
// wires to the same first-to-answer bridge that permissions use, so the TUI overlay
// and any connected browser can both answer and whichever lands first wins.
//
// Refuses when there is nobody to ask (headless, sub-agents) rather than hanging —
// a tool that blocks forever is worse than one that admits it can't help.
import type { ToolContext, ToolResult } from "./index.js";
import type { AskUserArgs } from "./schemas.js";

export async function runAskUser(args: AskUserArgs, signal?: AbortSignal, ctx?: ToolContext): Promise<ToolResult> {
  const question = String(args.question ?? "").trim();
  if (!question) return { output: "ask_user needs a question.", isError: true };

  if (!ctx?.askUser) {
    return {
      output:
        "Refused: no interactive user to ask (headless or sub-agent context). " +
        "State your assumption explicitly and continue with the most reasonable interpretation.",
      isError: true,
    };
  }
  // Cap the option list so a runaway model can't render an unusable prompt.
  const options = (args.options ?? []).map((o) => String(o).trim()).filter(Boolean).slice(0, 5);

  const answer = await ctx.askUser(question, options, signal);
  if (answer.aborted) return { output: "Question cancelled.", isError: false, aborted: true };
  if (answer.timedOut) {
    return {
      output:
        `No answer within the time limit. Proceed with your best judgement and say which assumption you made.` +
        (options.length ? ` The choices offered were: ${options.join(", ")}.` : ""),
      isError: false,
    };
  }
  return { output: `The user answered: ${answer.text}`, isError: false };
}

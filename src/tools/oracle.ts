import type { OracleArgs } from "./schemas.js";
import type { ToolContext, ToolResult } from "./index.js";

/**
 * Hand a hard sub-problem to a stronger model (config `oracleModel`) in its own
 * isolated context: a single turn, no tools, no history. The heavy lifting (the
 * one-shot completion + separate cost attribution) is done by the engine via
 * ctx.oracle — this tool just formats the answer with a one-line accounting header.
 */
export async function runOracle(args: OracleArgs, signal?: AbortSignal, ctx?: ToolContext): Promise<ToolResult> {
  const run = ctx?.oracle;
  if (!run) return { output: "the oracle tool is not available here", isError: true };
  try {
    const res = await run(args.question, signal);
    const meta = `${res.model} · ${res.tokens} tokens · $${res.usd.toFixed(4)}`;
    return { output: `${meta}\n${res.text}`, isError: false };
  } catch (e) {
    return { output: `oracle: ${(e as Error).message}`, isError: true };
  }
}

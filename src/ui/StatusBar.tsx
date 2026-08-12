import { Box, Text } from "ink";
import os from "node:os";
import { C } from "./theme.js";
import type { Caps } from "./terminal.js";

interface Props {
  caps: Caps;
  /** Hard width budget (columns - 2). The row is kept to this many cells so it
   * never wraps to a second physical line. */
  width: number;
  cwd: string;
  branch: string | null;
  dirtyCount: number;
  modelName: string;
  contextWindow: number;
  /** Running token estimate (engine.contextTokens) — same numerator as compaction. */
  tokens: number;
  cost: number;
}

function fmtK(n: number): string {
  if (n < 1000) return String(n);
  if (n >= 1e6) {
    const m = n / 1e6;
    return (m >= 10 ? String(Math.round(m)) : m.toFixed(1).replace(/\.0$/, "")) + "M";
  }
  const k = n / 1000;
  return (k >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, "")) + "K";
}

function shortCwd(cwd: string): string {
  const home = os.homedir();
  const norm = cwd.split("\\").join("/");
  const h = home.split("\\").join("/");
  return norm.startsWith(h) ? "~" + norm.slice(h.length) : norm;
}

/** Context-usage colour: green < 60%, yellow 60–85%, red > 85%. */
export function meterColor(pct: number): string {
  if (pct < 60) return C.added;
  if (pct <= 85) return "#fbbf24";
  return C.removed;
}

export function StatusBar({ caps, width, cwd, branch, dirtyCount, modelName, contextWindow, tokens, cost }: Props) {
  const g = caps.glyphs;
  const col = (hex: string) => (caps.color ? hex : undefined);

  const pct = contextWindow > 0 ? Math.round((tokens / contextWindow) * 100) : 0;
  const filled = Math.max(0, Math.min(10, Math.round((Math.min(pct, 100) / 100) * 10)));
  const barColor = meterColor(pct);
  const costStr = "$" + (cost >= 0.01 ? cost.toFixed(2) : cost.toFixed(4));

  // Assemble the row as plain segments first so its exact cell width is known.
  // Everything except the model id is fixed; the model id is the single elastic
  // piece, truncated with an ellipsis so the whole row fits `width` on one line.
  const cwdStr = shortCwd(cwd);
  const branchMid = ` ${g.mid} `;
  const branchStr = branch ? `${branch} ` : "";
  const dirtyStr = branch ? `${g.dot}${dirtyCount}` : "";
  const gap = "    ";
  const ctxStr = ` (${contextWindow > 0 ? fmtK(contextWindow) : "?"} context) ${g.v} `;
  const barOn = g.barFull.repeat(filled);
  const barOff = g.barEmpty.repeat(10 - filled);
  const pctStr = ` ${pct}%`;
  const gap2 = "  ";

  const fixed =
    cwdStr.length +
    (branch ? branchMid.length + branchStr.length + dirtyStr.length : 0) +
    gap.length +
    ctxStr.length +
    barOn.length +
    barOff.length +
    pctStr.length +
    gap2.length +
    costStr.length;

  let model = modelName;
  const avail = width - fixed;
  if (model.length > avail) model = avail <= 1 ? "" : model.slice(0, Math.max(0, avail - 1)) + "…";

  return (
    <Box width={width}>
      <Text color={col(C.value)} wrap="truncate">{cwdStr}</Text>
      {branch && (
        <>
          <Text color={col(C.dim)} wrap="truncate">{branchMid}</Text>
          <Text color={col(C.value)} wrap="truncate">{branchStr}</Text>
          <Text color={col(C.cyan)} wrap="truncate">{dirtyStr}</Text>
        </>
      )}
      <Text color={col(C.dim)} wrap="truncate">{gap}</Text>
      <Text color={col(C.model)} wrap="truncate">{model}</Text>
      <Text color={col(C.dim)} wrap="truncate">{ctxStr}</Text>
      <Text color={col(barColor)} wrap="truncate">{barOn}</Text>
      <Text color={col(C.dim)} wrap="truncate">{barOff}</Text>
      <Text color={col(barColor)} wrap="truncate">{pctStr}</Text>
      <Text color={col(C.dim)} wrap="truncate">{gap2}</Text>
      <Text color={col(C.value)} wrap="truncate">{costStr}</Text>
    </Box>
  );
}

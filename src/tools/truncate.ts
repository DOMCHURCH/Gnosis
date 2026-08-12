// Every tool result passes through here. One unbounded build log would otherwise
// destroy the context window.

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
const HEAD = 1000;
const TAIL = 1000;

export function truncateOutput(text: string): string {
  let out = text;

  const lines = out.split("\n");
  if (lines.length > MAX_LINES) {
    const omitted = lines.length - HEAD - TAIL;
    out = [
      ...lines.slice(0, HEAD),
      `[${omitted} lines truncated]`,
      ...lines.slice(lines.length - TAIL),
    ].join("\n");
  }

  if (Buffer.byteLength(out, "utf8") > MAX_BYTES) {
    const half = Math.floor(MAX_BYTES / 2);
    const head = Buffer.from(out, "utf8").subarray(0, half).toString("utf8");
    const tail = Buffer.from(out, "utf8").subarray(Buffer.byteLength(out, "utf8") - half).toString("utf8");
    out = `${head}\n[output truncated: exceeded ${MAX_BYTES} bytes]\n${tail}`;
  }

  return out;
}

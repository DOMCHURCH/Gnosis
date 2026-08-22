// Best-effort "which port did this job open" detection, by snapshot-diff: we note
// the set of listening TCP ports just before spawning a background job, then a
// moment later diff against the live set — a port that wasn't there before and is
// there now is attributed to the job (a dev server, usually). This is a heuristic
// for the human-facing background panel, not a security boundary; concurrent
// spawns can race, in which case we simply show no port. The parse step is a pure
// string→Set so it can be unit-tested offline without touching the network.

import { execa } from "execa";

/**
 * Extract listening TCP port numbers from `netstat`/`ss` output. We only look at
 * lines that mention LISTEN(ING) and take the FIRST `:port` token on the line —
 * which is the LOCAL address on every layout we target:
 *   Windows `netstat -ano`:  `  TCP    127.0.0.1:7777   0.0.0.0:0   LISTENING  1234`
 *   Linux   `ss -tln`:       `LISTEN 0  128  0.0.0.0:22   0.0.0.0:*`
 *   macOS   `netstat -an`:   `tcp4   0  0  127.0.0.1.7777  *.*   LISTEN`  (dot before port)
 */
export function parseListeningPorts(output: string, platform: NodeJS.Platform = process.platform): Set<number> {
  const ports = new Set<number>();
  for (const line of String(output).split(/\r?\n/)) {
    if (!/LISTEN/i.test(line)) continue;
    // macOS uses `host.port` (dot) where the host is itself dotted (127.0.0.1.7777),
    // so anchor the port to the end of the address token (whitespace/EOL). Elsewhere
    // it's `host:port`; the local address is the first such token on the line.
    const sep = platform === "darwin" ? /\.(\d{1,5})(?=\s|$)/ : /:(\d{1,5})\b/;
    const m = sep.exec(line);
    if (!m) continue;
    const p = Number(m[1]);
    if (p > 0 && p <= 65535) ports.add(p);
  }
  return ports;
}

function scanCommand(platform: NodeJS.Platform): { file: string; args: string[] } {
  if (platform === "win32") return { file: "netstat", args: ["-ano", "-p", "tcp"] };
  if (platform === "darwin") return { file: "netstat", args: ["-an", "-p", "tcp"] };
  return { file: "ss", args: ["-tln"] }; // linux
}

/** Snapshot the set of listening TCP ports right now (empty set if the tool is
 * missing or errors — detection just degrades to "no port"). */
export async function snapshotPorts(platform: NodeJS.Platform = process.platform): Promise<Set<number>> {
  const { file, args } = scanCommand(platform);
  try {
    const res = await execa(file, args, { reject: false, windowsHide: true, timeout: 4000 });
    return parseListeningPorts(res.stdout ?? "", platform);
  } catch {
    // Linux without `ss` → try netstat as a fallback before giving up.
    if (platform !== "win32" && platform !== "darwin") {
      try {
        const res = await execa("netstat", ["-tln"], { reject: false, timeout: 4000 });
        return parseListeningPorts(res.stdout ?? "", platform);
      } catch {
        /* no tool available */
      }
    }
    return new Set();
  }
}

/** Ports present now that were not present in `before` (candidates for a job). */
export function newPorts(before: Set<number>, after: Set<number>): number[] {
  const out: number[] = [];
  for (const p of after) if (!before.has(p)) out.push(p);
  return out.sort((a, b) => a - b);
}

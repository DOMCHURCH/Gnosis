// Cloudflare Tunnel integration for `/serve --public`. Spawns the cloudflared binary
// (bundled by the `cloudflared` npm wrapper) pointing at the local port, parses the
// public trycloudflare URL from its output, and hands back a stop() to kill it
// cleanly. Best-effort: any failure rejects so serve continues local-only.

import { spawn, type ChildProcess } from "node:child_process";

export interface TunnelHandle {
  url: string;
  stop(): void;
}

/** Pull the public URL out of cloudflared's log stream, or null if not present yet. */
export function parseTunnelUrl(text: string): string | null {
  const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return m ? m[0] : null;
}

/**
 * Start a quick Cloudflare Tunnel to http://127.0.0.1:<port> and resolve once its
 * public URL appears. Rejects on spawn error, early exit, or timeout — the caller
 * warns and keeps serving locally. The returned stop() kills the child.
 */
export async function startTunnel(port: number, timeoutMs = 25000): Promise<TunnelHandle> {
  const mod = await import("cloudflared");
  const bin = (mod as { bin: string }).bin;
  return new Promise<TunnelHandle>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return reject(e as Error);
    }
    let settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const onData = (buf: Buffer) => {
      const url = parseTunnelUrl(buf.toString());
      if (url) finish(() => resolve({ url, stop: () => { try { child.kill(); } catch { /* already gone */ } } }));
    };
    child.stderr?.on("data", onData);
    child.stdout?.on("data", onData);
    child.on("error", (e) => finish(() => reject(e)));
    child.on("exit", (code) => finish(() => reject(new Error(`cloudflared exited before a URL appeared (code ${code})`))));
    const timer = setTimeout(() => finish(() => { try { child.kill(); } catch { /* ignore */ } reject(new Error("cloudflared did not produce a public URL in time")); }), timeoutMs);
  });
}

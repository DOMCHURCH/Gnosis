// Web terminal backend: one real OS pseudo-terminal per browser terminal tab,
// reachable ONLY over the token-gated `/pty` websocket the server upgrades. This
// is a HUMAN channel — its output never touches the event bus and is never fed to
// the model. PTYs are process-global bookkeeping so they can all be torn down when
// `dom serve` stops (they die with the session). node-pty is imported dynamically
// so a missing/broken native binary degrades to "terminals unavailable" instead of
// taking down the whole server.

import { resolveShell } from "./tools/bash.js";

export interface Pty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: () => void): void;
  kill(): void;
  pid: number;
}

// Every live pty, so close() can reap them all when the server stops.
const live = new Set<Pty>();

/** Spawn a login shell in `cwd` as a pty. Throws if node-pty can't load (caller
 * turns that into a clean "unavailable" close). cols/rows seed the initial size. */
export async function spawnPty(cwd: string, cols = 80, rows = 24): Promise<Pty> {
  const mod: any = await import("node-pty");
  const shell = resolveShell();
  // Interactive shell (NOT `-c cmd`, which would run one command and exit).
  const isPwsh = /powershell|pwsh/i.test(shell.file);
  const args = isPwsh ? ["-NoLogo", "-NoProfile"] : ["-i"];
  const proc = mod.spawn(shell.file, args, {
    name: "xterm-color",
    cols,
    rows,
    cwd,
    env: process.env,
    // On Windows node-pty uses ConPTY; a benign console-attach warning may print.
    useConpty: process.platform === "win32" ? true : undefined,
  });
  const pty: Pty = {
    pid: proc.pid,
    write: (d) => proc.write(d),
    resize: (c, r) => { try { proc.resize(Math.max(1, c), Math.max(1, r)); } catch { /* window gone */ } },
    onData: (cb) => proc.onData(cb),
    onExit: (cb) => proc.onExit(() => cb()),
    kill: () => { try { proc.kill(); } catch { /* already dead */ } live.delete(pty); },
  };
  live.add(pty);
  return pty;
}

/** Kill every live pty (called when the server closes). */
export function killAllPtys(): void {
  for (const p of [...live]) p.kill();
  live.clear();
}

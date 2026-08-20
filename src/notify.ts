// Desktop notifications when a turn finishes or needs approval. Best-effort and
// dependency-free. Over SSH a native notifier (osascript/notify-send) would pop on
// the REMOTE host — useless — so we fall back to a terminal escape (OSC 9 + bell)
// that the user's LOCAL terminal renders. That same terminal path is the fallback
// everywhere a native notifier is unavailable (Windows without a toast dep).

import { execFile } from "node:child_process";

export type Strategy = "osascript" | "notify-send" | "terminal";

const ESC = String.fromCharCode(27); // ESC 
const BEL = String.fromCharCode(7); // BEL 

/** True when the session is remote (SSH) — native notifiers target the wrong box. */
export function isSSH(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.SSH_TTY || env.SSH_CONNECTION || env.SSH_CLIENT);
}

/** Pick the notifier. SSH and anything without a native tool use the terminal. */
export function pickStrategy(opts: { platform: NodeJS.Platform; ssh: boolean }): Strategy {
  if (opts.ssh) return "terminal";
  if (opts.platform === "darwin") return "osascript";
  if (opts.platform === "linux") return "notify-send";
  return "terminal"; // win32 & others: OSC 9 + bell (no native dependency)
}

/** Bytes asking the LOCAL terminal to notify: OSC 9 (iTerm2/kitty/WezTerm),
 * BEL-terminated, then a standalone BEL so terminals without OSC 9 still ring.
 * Travels over SSH to the local terminal. */
export function terminalNotifySequence(message: string): string {
  const safe = Array.from(message).filter((c) => c.charCodeAt(0) >= 32).join("").slice(0, 160);
  return `${ESC}]9;${safe}${BEL}${BEL}`;
}

/** AppleScript string literal quoting. */
function osaQuote(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export interface NotifyOptions {
  /** Config flag; false disables entirely. */
  enabled?: boolean;
  /** Override the chosen strategy (tests). */
  strategy?: Strategy;
  /** Where terminal escapes are written (default process.stderr). */
  sink?: (s: string) => void;
  /** Spawner for native notifiers (default execFile); called (file, args, onError). */
  run?: (file: string, args: string[], onError: () => void) => void;
}

/** Send a notification, falling back to the terminal bell. Never throws. */
export function notify(title: string, body: string, opts: NotifyOptions = {}): void {
  if (opts.enabled === false) return;
  const strategy = opts.strategy ?? pickStrategy({ platform: process.platform, ssh: isSSH() });
  const sink = opts.sink ?? ((s) => { try { process.stderr.write(s); } catch { /* no tty */ } });
  const run =
    opts.run ??
    ((file, args, onError) => {
      try {
        execFile(file, args, (err) => { if (err) onError(); });
      } catch {
        onError();
      }
    });
  const bell = () => sink(terminalNotifySequence(`${title} — ${body}`));

  try {
    if (strategy === "osascript") {
      run("osascript", ["-e", `display notification ${osaQuote(body)} with title ${osaQuote(title)}`], bell);
    } else if (strategy === "notify-send") {
      run("notify-send", [title, body], bell);
    } else {
      bell();
    }
  } catch {
    bell();
  }
}

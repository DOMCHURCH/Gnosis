// Clipboard paste for the terminal input.
//
// Terminals differ on Ctrl+V. Windows Terminal, iTerm and friends intercept it
// themselves and send the clipboard as a normal chunk of characters, which the
// input field already handles — those never reach this module. Plain conhost, a
// bare xterm, and the PTY inside `dom serve` do NOT: they send 0x16 (SYN), which
// Ink reports as `{ ctrl: true, name: "v" }`. ink-text-input does not look at
// `ctrl`, so it inserted a literal "v" and the clipboard was never read. From the
// user's side the paste simply did not arrive.
//
// So Ctrl+V is handled here: read the OS clipboard ourselves and splice it in.

import { spawnSync } from "node:child_process";

/** Run a command and return stdout, or "" if it is missing or fails. Never throws:
 *  a clipboard that cannot be read is an empty paste, not a crash. */
function run(cmd: string, args: string[]): string {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 2000, windowsHide: true });
    return r.status === 0 ? r.stdout ?? "" : "";
  } catch {
    return "";
  }
}

/**
 * The OS clipboard as text, or "" when it holds nothing readable.
 *
 * Synchronous on purpose. The key handler has to produce the new input value in
 * the same tick the keypress is delivered, because the text field has already
 * queued its own (wrong) update for that keypress and ours has to land after it.
 */
export function readClipboard(): string {
  if (process.platform === "win32") {
    // -Raw keeps a multi-line clipboard as ONE string; without it PowerShell
    // prints an array and the lines come back space-joined.
    return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"]);
  }
  if (process.platform === "darwin") return run("pbpaste", []);
  // Wayland first, then X11 — whichever is installed.
  return run("wl-paste", ["--no-newline"]) || run("xclip", ["-selection", "clipboard", "-o"]);
}

const TAB = 9;
const NEWLINE = 10;
const SPACE = 32;
const DELETE = 127;

/** True for a character a one-line input can actually hold. Tab and newline stay;
 *  every other C0 control character goes. They cannot be typed, they corrupt the
 *  frame mid-render, and a pasted escape sequence would be re-read as a keypress. */
function isPrintable(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return c === TAB || c === NEWLINE || (c >= SPACE && c !== DELETE);
}

/**
 * Clipboard text made safe for the input box.
 *
 * CRLF becomes LF — the Windows clipboard is full of it, and a stray carriage
 * return sends the cursor to column 0 in the middle of a frame. PowerShell's
 * `Get-Clipboard` also appends one newline of its own, which is removed: a paste
 * should not add a blank line the user never copied.
 */
export function normalizePaste(raw: string): string {
  const text = raw.replace(/\r\n?/g, "\n");
  return [...text].filter(isPrintable).join("").replace(/\n$/, "");
}

/**
 * Fold a paste into the input value.
 *
 * `rendered` is the value as of the last render; `current` is what the text field
 * produced for this very keypress. Because ink-text-input reads Ctrl+V as the
 * letter "v", `current` is `rendered` with one stray "v" inserted at the cursor.
 * Find that character and swap it for the pasted text, so the paste lands where
 * the cursor was and no "v" survives.
 *
 * If the field did not get there first (listener order is not guaranteed), the
 * lengths do not line up and the paste is appended instead — still correct, just
 * always at the end.
 */
export function applyPaste(rendered: string, current: string, text: string): string {
  if (current.length === rendered.length + 1) {
    let i = 0;
    while (i < rendered.length && rendered[i] === current[i]) i++;
    if (current[i] === "v") return current.slice(0, i) + text + current.slice(i + 1);
  }
  return current + text;
}

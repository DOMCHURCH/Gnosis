// Command-hiding defense: normalize a shell command for the approval prompt so
// nothing can hide part of it from a human. Tabs, invisible/zero-width/bidi
// Unicode, and other control characters are revealed as <U+XXXX> (or visible
// markers), and the presence of hidden characters is flagged `suspicious` so the
// gate can force a prompt even in yolo. The REAL command still executes unchanged;
// this only affects what's displayed.

// Zero-width, bidi-override, joiners, BOM, soft hyphen, Mongolian vowel separator.
const INVISIBLE = "\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\u00AD\\u180E";
// Control chars EXCEPT tab (U+0009) and newline (U+000A) — CR handled separately.
const CONTROL = "\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F";

const RE_CONTROL_OR_CR = new RegExp(`[${CONTROL}\\r]`);
const RE_INVISIBLE = new RegExp(`[${INVISIBLE}]`);
const RE_REVEAL = new RegExp(`[${CONTROL}${INVISIBLE}]`, "g");

function asCodepoint(c: string): string {
  return `<U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}>`;
}

export interface NormalizedCommand {
  /** The command with hidden characters revealed — for display only. */
  display: string;
  /** True when the command contained genuinely hidden characters (control /
   * invisible / bidi) — the gate treats these as dangerous (always prompt). */
  suspicious: boolean;
  reasons: string[];
}

export function normalizeCommand(command: string): NormalizedCommand {
  const reasons: string[] = [];
  const hasControl = RE_CONTROL_OR_CR.test(command);
  const hasInvisible = RE_INVISIBLE.test(command);
  const hasTab = command.includes("\t");
  if (hasControl) reasons.push("hidden control characters");
  if (hasInvisible) reasons.push("invisible/bidi Unicode");
  if (hasTab) reasons.push("tab characters");
  if (command.includes("\n")) reasons.push("multiple lines / chained commands"); // visible, but noted

  const display = command
    .replace(RE_REVEAL, asCodepoint)
    .replace(/\r/g, "<U+000D>")
    .replace(/\t/g, " ⇥ ");

  // Hidden characters (control / invisible / tab) force a prompt even in yolo;
  // newlines/chaining are visible in the revealed display, so they don't.
  return { display, suspicious: hasControl || hasInvisible || hasTab, reasons };
}

/** True when a command hides content behind control/invisible/bidi characters. */
export function hasHiddenChars(command: string): boolean {
  return normalizeCommand(command).suspicious;
}

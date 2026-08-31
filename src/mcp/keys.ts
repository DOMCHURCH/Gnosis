// Key-name aliases for computer-use servers.
//
// There is no standard vocabulary for key names across MCP desktop-control
// servers, and the names a model reaches for first are the ones printed on the
// keyboard: "win", "cmd", "esc", "del", "pgup". A server that wants X11-style
// names answers `Unknown key in combo: win` — observed exactly that way in a
// live session, where the model then abandoned the keyboard entirely and spent
// the rest of the turn blind-clicking at the taskbar trying to find the Start
// button by eye.
//
// The failure is silly and the cost was the whole turn, so this fixes it rather
// than asking the model to memorise a vocabulary it cannot see. The strategy is
// RETRY, not rewrite: the original arguments are sent first, exactly as the
// model wrote them, and the alias pass only runs if the server comes back with
// an unknown-key error. A server that happily accepts "win" never errors, so it
// never reaches this and its behaviour is unchanged — which matters, because we
// have no way to know which vocabulary any given server speaks.

/** What the model tends to write -> what desktop-control servers tend to want. */
const ALIASES: Record<string, string> = {
  // The Windows/Command key. "super" is the X11 name most of these servers use.
  win: "super",
  windows: "super",
  meta: "super",
  cmd: "super",
  command: "super",
  os: "super",
  // Modifiers.
  ctrl: "control",
  option: "alt",
  opt: "alt",
  // Named keys.
  esc: "escape",
  del: "delete",
  ins: "insert",
  pgup: "pageup",
  pgdn: "pagedown",
  pagedn: "pagedown",
  ret: "return",
  enter: "return",
  spc: "space",
  spacebar: "space",
  bksp: "backspace",
  back: "backspace",
};

/** True when a server's error text is complaining about a key name. */
export function isUnknownKeyError(text: string): boolean {
  return /unknown key|invalid key|unrecognized key|no such key|bad key/i.test(text);
}

/**
 * Rewrite key names inside a string: "ctrl+win+left" -> "control+super+left".
 * Splits on the separators these servers accept and maps each part.
 */
export function aliasCombo(combo: string): string {
  return combo
    .split(/([+\-\s,])/) // keep separators so the shape is preserved exactly
    .map((part) => ALIASES[part.trim().toLowerCase()] ?? part)
    .join("");
}

/**
 * Apply key aliases to a tool call's arguments.
 *
 * Only the fields that plausibly carry a key name are touched — `key`, `keys`,
 * `combo`, `hotkey`, `shortcut` — and never a `text` field, because typing the
 * literal word "win" into a document must not become "super". Returns null when
 * nothing changed, so the caller can skip a pointless retry.
 */
export function aliasKeyArgs(args: unknown): Record<string, unknown> | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const KEY_FIELDS = new Set(["key", "keys", "combo", "hotkey", "shortcut", "combination"]);
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  let changed = false;

  for (const [k, v] of Object.entries(out)) {
    if (!KEY_FIELDS.has(k.toLowerCase())) continue;
    if (typeof v === "string") {
      const next = aliasCombo(v);
      if (next !== v) { out[k] = next; changed = true; }
    } else if (Array.isArray(v)) {
      const next = v.map((e) => (typeof e === "string" ? aliasCombo(e) : e));
      if (next.some((e, i) => e !== v[i])) { out[k] = next; changed = true; }
    }
  }
  return changed ? out : null;
}

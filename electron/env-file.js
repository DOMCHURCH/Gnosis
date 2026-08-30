// Reading and rewriting ~/.dom/.env.
//
// That file is not ours alone: it holds the OpenRouter key, BRAVE_API_KEY and
// whatever HTTP-tool secrets the user has put there, plus their comments. So the
// settings panel edits it surgically — the line for the key being changed is
// replaced in place, and every other byte survives. Rewriting the file from a
// parsed object would silently eat comments and any key this UI doesn't know
// about, which is exactly the kind of data loss a settings dialog must never do.
//
// Pure string/object functions, no Electron and no fs, so the merge rules can be
// tested on their own.

/** Parse .env text the same way src/config.ts loadEnv() does — same trimming,
 * same comment skipping, same surrounding-quote stripping. If these two ever
 * disagree, the panel would show a key the agent can't actually read. */
export function parseEnv(text) {
  const env = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k) env[k] = v;
  }
  return env;
}

/** Show enough of a secret to recognise it, never enough to use it. Short values
 * are reported only as "set" — masking a 6-character string by showing 8 of its
 * characters would leak the whole thing. */
export function maskSecret(value) {
  if (!value) return null;
  const v = String(value);
  if (v.length < 12) return "•".repeat(8);
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
}

/** A value safe to write as one `KEY=value` line. Newlines are the dangerous
 * case: one pasted into a value would become additional env entries. */
export function assertWritableValue(value) {
  if (/[\r\n]/.test(value)) throw new Error("Value cannot contain line breaks.");
  if (value.includes("\0")) throw new Error("Value cannot contain null bytes.");
}

function formatLine(key, value) {
  // loadEnv trims before stripping quotes, so a value whose own edges are spaces
  // needs quoting to survive the round trip. Everything else stays bare.
  const needsQuotes = value !== value.trim() || value.startsWith('"') || value.startsWith("'");
  return `${key}=${needsQuotes ? JSON.stringify(value) : value}`;
}

/**
 * Merge `updates` into .env text. A string value sets the key (replacing its
 * existing line, wherever that is); null deletes it; a key absent from `updates`
 * is not touched. Returns the new text.
 */
export function mergeEnv(text, updates) {
  const original = String(text ?? "");
  const lines = original.split(/\r?\n/);
  const eol = original.includes("\r\n") ? "\r\n" : "\n";

  for (const [key, value] of Object.entries(updates)) {
    if (value !== null) assertWritableValue(value);
    // `\\s` and `\\$&`, not `\s` and `\$&`: in a template literal a lone backslash
    // before an ordinary character is dropped, so the previous spelling compiled
    // to `^s*KEY s*=` — zero-or-more literal "s" — and quietly failed to find any
    // line that was indented. It matched the common unindented case, which is why
    // it survived. `\\$&` in the replacement is a literal backslash followed by
    // the match, i.e. the escape that makes a regex-special character literal.
    const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
    // Last occurrence wins, because that is the one parseEnv/loadEnv resolves to.
    let idx = -1;
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i]) && !lines[i].trim().startsWith("#")) idx = i;

    if (value === null) {
      if (idx !== -1) lines.splice(idx, 1);
      continue;
    }
    if (idx !== -1) lines[idx] = formatLine(key, value);
    else {
      // Append, keeping exactly one trailing newline at the end of the file.
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      lines.push(formatLine(key, value));
      lines.push("");
    }
  }
  return lines.join(eol);
}

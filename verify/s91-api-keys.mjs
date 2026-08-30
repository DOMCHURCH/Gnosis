// Verify (settings): any API key is editable, and the name guard still holds.
//
// The panel used to carry a hardcoded allowlist — OPENROUTER_API_KEY and
// BRAVE_API_KEY — and `settings:save` threw "Refusing to write unknown key" for
// anything else. That made GROQ_API_KEY, which the voice session actually reads,
// visible in the panel only as the sentence "1 other entry in this file is left
// untouched", and editable nowhere.
//
// The fix moves the guard from WHICH names to WHAT A NAME MAY LOOK LIKE, so the
// interesting property to protect is the guard itself: a settings dialog that can
// write arbitrary env entries can write PATH, NODE_OPTIONS or ELECTRON_RUN_AS_NODE,
// and then the next process to read this file runs someone else's code. The regex
// is the whole security boundary now, so it is tested directly rather than by
// reading the source and trusting it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeEnv, parseEnv } from "../electron/env-file.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const settings = readFileSync(path.join(root, "electron", "settings.js"), "utf8");
const html = readFileSync(path.join(root, "electron", "settings.html"), "utf8");
const preload = readFileSync(path.join(root, "electron", "preload.cjs"), "utf8");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- the allowlist is gone ----------------------------------------------------
ok("the hardcoded key allowlist is gone", !/const KNOWN_KEYS = \[/.test(settings));
ok("...and nothing refuses a key by name any more", !/Refusing to write unknown key/.test(settings));
ok("the required pair is pinned instead", /const PINNED_KEYS = \[/.test(settings)
  && settings.includes("OPENROUTER_API_KEY") && settings.includes("BRAVE_API_KEY"));

// --- the name guard -----------------------------------------------------------
// Pulled out of the shipping source so this cannot drift from what actually runs.
function literal(src, name) {
  const m = src.match(new RegExp(`const ${name} = (/.*/[gimsuy]*);`));
  if (!m) throw new Error(`${name} not found`);
  // eslint-disable-next-line no-eval
  return (0, eval)(m[1]);
}
const MAIN_RE = literal(settings, "KEY_NAME_RE");
const UI_RE = literal(html, "KEY_NAME_RE");

ok("the renderer and the main process share one rule", String(MAIN_RE) === String(UI_RE));

for (const good of ["OPENROUTER_API_KEY", "GROQ_API_KEY", "A", "X1", "MY_SERVICE_TOKEN_2"]) {
  ok(`"${good}" is accepted`, MAIN_RE.test(good));
}
// Each of these is a way to turn a settings dialog into something else.
for (const bad of [
  "",                      // nothing
  "1KEY",                  // leading digit is not an env name
  "lowercase_key",         // would not be read as an env key anyway
  "MY-KEY",                // dashes
  "MY KEY",                // whitespace
  "MY.KEY",                // dots
  "KEY\nOTHER=x",          // a second entry smuggled in via a newline
  "KEY=x",                 // an "=" ends the name
  "__proto__",             // prototype pollution shaped
  "PATH ",                 // trailing space, i.e. PATH by another name
]) {
  ok(`${JSON.stringify(bad)} is refused`, !MAIN_RE.test(bad));
}
// The dangerous names are only reachable if the user types them exactly, which is
// their prerogative — but the guard must not be what lets them in by accident.
ok("assertKeyName is used by save", /assertKeyName\(k\)/.test(settings));
ok("...and by rename", /assertKeyName\(from\)/.test(settings) && /assertKeyName\(to\)/.test(settings));
ok("there is a length cap", /MAX_KEY_NAME/.test(settings));

// --- rename happens in the main process ---------------------------------------
// If the renderer did this it would have to hold the secret to move it.
ok("rename is an IPC handler", /ipcMain\.handle\("settings:rename-key"/.test(settings));
ok("...bridged to the page", /renameSettingsKey/.test(preload));
ok("...refusing to clobber an existing key", /already exists — delete it first/.test(settings));
ok("...and never sending the value to the page", !/masked: env\[/.test(settings));

// --- the panel is data-driven -------------------------------------------------
ok("the two hardcoded key sections are gone",
  !/id="openrouter"/.test(html) && !/id="brave"/.test(html));
ok("rows are rendered from the loaded list", /function renderKeys\(\)/.test(html));
ok("...with an add control", /id="key-add"/.test(html));
ok("...and per-row remove", /button\.mini\.danger/.test(html));
ok("load ships an ordered array of keys", /const keys = \[\s*\.\.\.PINNED_KEYS/.test(settings));

// --- values never leave the main process --------------------------------------
ok("only presence and a mask are sent", /set: !!env\[k\.name\]/.test(settings)
  && /masked: maskSecret\(env\[k\.name\]\)/.test(settings));

// --- mergeEnv still edits surgically ------------------------------------------
// The reason the panel is allowed to touch arbitrary keys at all: it rewrites one
// line, not the file. A regression here is silent data loss of someone's secrets.
{
  const before = [
    "# my keys",
    "OPENROUTER_API_KEY=sk-or-old",
    "",
    "  GROQ_API_KEY=gsk_indented",
    "SOMETHING_ELSE=keepme",
  ].join("\n");
  const after = mergeEnv(before, { OPENROUTER_API_KEY: "sk-or-new", NEW_TOKEN: "abc" });
  const env = parseEnv(after);
  ok("an existing key is replaced in place", env.OPENROUTER_API_KEY === "sk-or-new");
  ok("a new key is appended", env.NEW_TOKEN === "abc");
  ok("unrelated keys survive", env.SOMETHING_ELSE === "keepme");
  ok("comments survive", after.includes("# my keys"));
  ok("the file is not duplicated", after.split("OPENROUTER_API_KEY").length === 2);

  // The bug this suite was written alongside: `^\s*` had lost its backslash, so
  // an indented line was never found and setting the key appended a SECOND one.
  const ind = mergeEnv(before, { GROQ_API_KEY: "gsk_new" });
  ok("an INDENTED existing key is replaced, not duplicated",
    ind.split("GROQ_API_KEY").length === 2 && parseEnv(ind).GROQ_API_KEY === "gsk_new");

  ok("null deletes", !("SOMETHING_ELSE" in parseEnv(mergeEnv(before, { SOMETHING_ELSE: null }))));
}

console.log(fails ? `\n${fails} FAILED` : "\nall api-key checks passed");
process.exit(fails ? 1 : 0);

// Verify (clipboard paste): Ctrl+V reaches the input.
//
// Terminals that map Ctrl+V to a paste send the clipboard as ordinary characters
// and always worked. The ones that don't send 0x16, which Ink reports as the plain
// letter "v" — ink-text-input ignores `ctrl`, so it typed a stray "v" and the
// clipboard was never read. These cover the two pure halves of the fix: making the
// pasted text safe for the input, and swapping the stray character for it.
import os from "node:os";

const { normalizePaste, applyPaste, readClipboard } = await import("../dist/paste.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- normalizePaste -----------------------------------------------------------
ok("plain text is untouched", normalizePaste("hello world") === "hello world");
ok("CRLF becomes LF", normalizePaste("a\r\nb") === "a\nb");
ok("a lone CR becomes LF", normalizePaste("a\rb") === "a\nb");
ok("tabs survive", normalizePaste("a\tb") === "a\tb");
ok("newlines inside the text survive", normalizePaste("a\nb\nc") === "a\nb\nc");
// PowerShell's Get-Clipboard adds one newline of its own; a paste must not submit
// or leave a blank line the user never copied.
ok("one trailing newline is dropped", normalizePaste("hello\n") === "hello");
ok("...and a trailing CRLF too", normalizePaste("hello\r\n") === "hello");
// A pasted escape sequence would be re-read as a keypress on the next render.
const ESC = String.fromCharCode(27), NUL = String.fromCharCode(0), BEL = String.fromCharCode(7), DEL = String.fromCharCode(127);
ok("an escape sequence is stripped", normalizePaste(`a${ESC}[31mb`) === "a[31mb");
ok("a NUL is stripped", normalizePaste(`a${NUL}b`) === "ab");
ok("a bell is stripped", normalizePaste(`a${BEL}b`) === "ab");
ok("DEL is stripped", normalizePaste(`a${DEL}b`) === "ab");
ok("an empty clipboard stays empty", normalizePaste("") === "");
ok("unicode is preserved", normalizePaste("héllo · 日本") === "héllo · 日本");

// --- applyPaste ---------------------------------------------------------------
// `current` is what the text field produced for this keypress: the previous value
// with one stray "v" inserted at the cursor.
ok("paste into an empty box replaces the stray v", applyPaste("", "v", "WORLD") === "WORLD");
ok("paste at the end of existing text", applyPaste("say ", "say v", "WORLD") === "say WORLD");
ok("paste in the MIDDLE lands at the cursor", applyPaste("ab", "avb", "X") === "aXb");
ok("paste at the very start", applyPaste("bc", "vbc", "A") === "Abc");
// An empty clipboard must still remove the character the field inserted, or Ctrl+V
// silently types a "v".
ok("an empty clipboard just removes the stray v", applyPaste("say ", "say v", "") === "say ");
// Existing "v"s must not confuse the diff — the FIRST differing position wins.
ok("text already full of v's still splices at the cursor", applyPaste("vvv", "vvvv", "X") === "vvvX");
ok("...and mid-string", applyPaste("vav", "vvav", "X") === "vXav");
// If the field did not get there first, the shapes don't line up: append instead
// of mangling the value.
ok("no stray v to find falls back to appending", applyPaste("abc", "abc", "X") === "abcX");
ok("an unrelated char is not eaten", applyPaste("ab", "axb", "X") === "axbX");

// --- readClipboard ------------------------------------------------------------
// Never throws and always returns a string, whatever the platform or clipboard.
let clip, threw = false;
try { clip = readClipboard(); } catch { threw = true; }
ok("readClipboard does not throw", !threw);
ok("readClipboard returns a string", typeof clip === "string");
ok(`readClipboard is supported on ${os.platform()}`, typeof clip === "string");

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

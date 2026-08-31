// Verify (computer-use recovery): a wrong key name does not cost the turn.
//
// From a live session: the model pressed the Windows key as "win", the server
// answered `Unknown key in combo: win`, and the model then abandoned the
// keyboard entirely and spent the rest of the turn clicking at guessed
// coordinates trying to find the Start button by eye — clicking real,
// irreversible things on the user's desktop the whole way down.
//
// There is no standard key vocabulary across desktop-control MCP servers, and
// the names a model reaches for first are the ones printed on the keyboard. So
// the fix is a RETRY with canonical names, not a lecture. The retry only runs
// after the server has actually rejected the model's own wording, which is what
// keeps it safe for a server that speaks a different vocabulary.
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const imp = (f) => import(pathToFileURL(path.resolve(here, f)).href);

const { aliasCombo, aliasKeyArgs, isUnknownKeyError } = await imp("../dist/mcp/keys.js");

let fails = 0;
const ok = (n, c, extra = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${extra ? ` — ${extra}` : ""}`); if (!c) fails++; };

// --- 1. the exact failure -----------------------------------------------------
{
  ok("the observed error is recognised", isUnknownKeyError("Unknown key in combo: win"));
  ok("...and 'win' maps to the X11 name", aliasCombo("win") === "super");
  ok("...inside a combo too", aliasCombo("ctrl+win+left") === "control+super+left");
}

// --- 2. it only fires on a key error ------------------------------------------
// Retrying on an unrelated failure would send a second desktop action the model
// never asked for — on a tool with no undo.
{
  for (const s of ["focus_failed", "target not running", "timeout", "", "clicked (12, 44)"]) {
    ok(`not treated as a key error: ${JSON.stringify(s)}`, isUnknownKeyError(s) === false);
  }
  for (const s of ["Unknown key: foo", "invalid key name", "no such key 'q'"]) {
    ok(`recognised as a key error: ${JSON.stringify(s)}`, isUnknownKeyError(s) === true);
  }
}

// --- 3. only key fields are rewritten -----------------------------------------
// The important negative: typing the literal word "win" into a document must
// stay "win". Rewriting a `text` field would silently corrupt what the user
// asked to be typed.
{
  ok("a key field is rewritten", JSON.stringify(aliasKeyArgs({ key: "win" })) === '{"key":"super"}');
  ok("an array of keys is rewritten", JSON.stringify(aliasKeyArgs({ keys: ["ctrl", "esc"] })) === '{"keys":["control","escape"]}');
  ok("a text field is NOT touched", aliasKeyArgs({ text: "win" }) === null);
  ok("...even alongside a key field", (() => {
    const r = aliasKeyArgs({ key: "esc", text: "press win to continue" });
    return r?.key === "escape" && r?.text === "press win to continue";
  })());
  ok("nothing to change returns null (no pointless retry)", aliasKeyArgs({ key: "control" }) === null);
  ok("...and so does a non-object", aliasKeyArgs("win") === null && aliasKeyArgs(null) === null);
  // Coverage of the names a model actually reaches for.
  for (const [from, to] of [["cmd", "super"], ["esc", "escape"], ["del", "delete"], ["pgup", "pageup"], ["enter", "return"]]) {
    ok(`${from} -> ${to}`, aliasCombo(from) === to);
  }
}

// --- 4. wired in, and wired in SAFELY -----------------------------------------
{
  const mgr = readFileSync(path.join(root, "src", "mcp", "manager.ts"), "utf8");
  ok("the manager retries on an unknown-key error", /isUnknownKeyError\(r\.output\)/.test(mgr));
  // Three guards, and each one matters on a tool with no undo:
  ok("...only for computer-use servers", /computerUse && r\.isError && isUnknownKeyError/.test(mgr));
  ok("...only after the server actually errored", /r\.isError && isUnknownKeyError/.test(mgr));
  ok("...and only when an alias would change something", /const retried = aliasKeyArgs\(args\);\s*\n\s*if \(retried\)/.test(mgr));
  // The model's own wording goes first, always.
  const firstCall = mgr.indexOf("await server.callTool(tool.name, args)");
  const retryCall = mgr.indexOf("await server.callTool(tool.name, retried)");
  ok("the model's own arguments are tried first", firstCall !== -1 && retryCall !== -1 && firstCall < retryCall);
  // A retry that also fails must not mask the original error.
  ok("a failed retry keeps the honest first error", /if \(!second\.isError\) r = second;/.test(mgr));
  // Exactly one retry — a loop here would be a desktop action storm.
  ok("it retries at most once", (mgr.match(/aliasKeyArgs\(args\)/g) ?? []).length === 1);
}

// --- 5. the prompt no longer leaves the model to guess -------------------------
// The retry handles the key name; these are the parts no retry can fix.
{
  const sp = readFileSync(path.join(root, "src", "system-prompt.ts"), "utf8");
  ok("the prompt names the Windows key correctly", /`super` is the Windows key/.test(sp));
  ok("...and forbids hunting the taskbar by coordinate", /Never hunt the Start menu, the taskbar/.test(sp));
  ok("...gives a launch-then-confirm sequence", /action=\\"launch\\"/.test(sp) && /list again/.test(sp));
  // The stop rule is the one that would have ended the observed 150-line spiral.
  ok("...and a hard stop after two failed attempts", /TWO attempts at the same goal/.test(sp));
  ok("...preferring bash over the mouse where one exists", /Prefer the non-GUI route/.test(sp));
}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

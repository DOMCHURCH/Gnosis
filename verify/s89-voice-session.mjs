// Verify (voice): the session rules, and the spoken model switch.
//
// The wake word opens a SESSION, not a single question — so the rules about when
// it stays open and when it ends are the feature. They are asserted here against
// the real patterns voice.js uses, because getting them wrong is invisible until
// someone is mid-sentence: too loose and it hangs up on "...and then stop
// listening for changes"; too tight and "that's all" leaves it running.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const voice = readFileSync(path.join(root, "electron", "voice.js"), "utf8");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

/** Pull a regex literal out of voice.js by the name it is bound to, so this tests
 * the pattern that actually ships rather than a copy that can drift. */
function literal(name) {
  const m = voice.match(new RegExp(`const ${name} = (/.*/[gimsuy]*);`));
  if (!m) throw new Error(`${name} not found in voice.js`);
  // eslint-disable-next-line no-eval
  return (0, eval)(m[1]);
}

const STOP_RE = literal("STOP_RE");
const SWITCH_RE = literal("SWITCH_RE");

// --- ending the session ---------------------------------------------------
for (const phrase of ["stop listening", "Stop listening.", "  that's all  ", "never mind", "nevermind",
                      "goodbye", "end session", "stop the session", "nothing else"]) {
  ok(`"${phrase.trim()}" ends the session`, STOP_RE.test(phrase));
}
// The whole point of anchoring it: these are ordinary sentences.
for (const phrase of [
  "stop listening for changes and rebuild",
  "can you stop listening to that port",
  "I never mind when the tests are slow",
  "say goodbye to the old parser and rewrite it",
  "that's all the config we need to change",
]) {
  ok(`"${phrase}" does NOT end the session`, !STOP_RE.test(phrase));
}

// --- switching models ------------------------------------------------------
for (const [phrase, want] of [
  ["switch to gemini", "gemini"],
  ["switch to gemini.", "gemini"],
  ["Switch to Claude", "Claude"],
  ["change to sonnet", "sonnet"],
  ["use gpt 4", "gpt 4"],
  ["switch model to deepseek", "deepseek"],
  ["switch to the gemini model", "gemini"],
]) {
  const m = phrase.match(SWITCH_RE);
  ok(`"${phrase}" reads as a switch to ${want}`, !!m && m[1].trim() === want);
}
// A one- or two-letter tail is not a model name; voice.js drops those.
{
  const m = "switch to it".match(SWITCH_RE);
  ok("a too-short target is rejected by the length guard", !m || m[1].trim().length < 3);
}

// --- the session wiring ----------------------------------------------------
// These assert the shape of the state machine rather than running Electron: each
// is a rule that, if removed, turns the session back into one-shot mode.
ok("a reply re-arms the recorder instead of closing", /if \(session\) \{ armIdle\(\); listenAgain\(\); \}/.test(voice));
ok("a silent turn keeps the session open", /session \? listenAgain\(\) : sleep\(\)/.test(voice));
ok("an unheard utterance keeps the session open", /if \(session\) setTimeout\(\(\) => listenAgain\(\), \d+\);/.test(voice));
ok("the idle timeout is 60s", /const IDLE_MS = 60000;/.test(voice));
ok("the idle timer ends the session", /endSession\("60s of silence"\)/.test(voice));
ok("the overlay's X ends the session", /ipcMain\.on\("voice:end-session", \(\) => endSession/.test(voice));
ok("a second wake word does not restart an open session", /if \(session\) return;/.test(voice));
ok("switching voice off ends the session", /endSession\("voice switched off"\)/.test(voice));

// --- the overlay -----------------------------------------------------------
const overlay = readFileSync(path.join(root, "electron", "voice-overlay.html"), "utf8");
ok("the overlay is 500x200", /const W = 500;[\s\S]{0,40}const H = 200;/.test(voice));
ok("...frameless and always on top", /frame: false,[\s\S]*alwaysOnTop: true,/.test(voice));
ok("...with no parent window, so the main window stays usable", !/parent: .*overlay/i.test(voice));
ok("...glassmorphic", /backdrop-filter: blur/.test(overlay));
ok("...with a gradient border", /background: linear-gradient\(135deg, var\(--cyan\)/.test(overlay));
ok("...a close button", /id="close"/.test(overlay));
ok("...a transcript line", /id="transcript"/.test(overlay));
ok("...a response line", /id="response"/.test(overlay));
ok("the waveform is driven by real audio, not a synthesised wave", /window\.voice\.onLevel/.test(overlay));
ok("...and the main process forwards the level to it", /voice:level-out/.test(voice));

console.log(fails ? `\n${fails} FAILED` : "\nall voice-session checks passed");
process.exit(fails ? 1 : 0);

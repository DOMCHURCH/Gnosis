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
ok("the overlay's X ends the session", /ipcMain\.on\("voice:end-session"/.test(voice));
ok("a second wake word does not restart an open session", /if \(session\) return;/.test(voice));
ok("switching voice off ends the session", /endSession\("voice switched off"\)/.test(voice));

// --- the overlay -----------------------------------------------------------
const overlay = readFileSync(path.join(root, "electron", "voice-overlay.html"), "utf8");
ok("there are two states, collapsed and expanded", /id="collapsed"/.test(overlay) && /id="expanded"/.test(overlay));
ok("the collapsed pill is ~440x92", /collapsed: \{ w: 440, h: 92 \}/.test(voice));
ok("the expanded panel is ~720x320", /expanded: \{ w: 720, h: 320 \}/.test(voice));
ok("the page drives the window size", /ipcMain\.on\("voice:resize"/.test(voice));
ok("...frameless and always on top", /frame: false,[\s\S]*alwaysOnTop: true,/.test(voice));
ok("...with no parent window, so the main window stays usable", !/parent: .*overlay/i.test(voice));
ok("...glassmorphic", /backdrop-filter: blur/.test(overlay));
// The material itself is covered in depth by s97-liquid-glass.mjs (real
// refraction, no colour tint, a liquid waveform). Kept here to just the
// structural fact this suite already cared about: there is a rim.
ok("...with a rim highlight", /\.frame \{[\s\S]*?background: linear-gradient\(180deg,/.test(overlay));
ok("the pill has a pulsing listening dot", /@keyframes pulse/.test(overlay));
ok("...a live waveform strip", /id="pillWave"/.test(overlay));
ok("...and a shield that badges a count", /id="shieldBtn"/.test(overlay) && /id="badge"/.test(overlay));
ok("the expanded panel has the four tabs",
  ["permissions", "memory", "tools", "settings"].every((t) => overlay.includes(`data-tab="${t}"`)));
ok("...state labels", /LISTENING/.test(overlay) && /PROCESSING/.test(overlay) && /READY/.test(overlay));
ok("...an ESC TO END hint", /ESC TO END/.test(overlay));
ok("...a Clear all link", /id="clearAll"/.test(overlay));
ok("...and the footer promise", /always ask before taking actions/.test(overlay));
ok("Esc ends the session", /e\.key === "Escape"/.test(overlay));
ok("the waveform is driven by real audio, not a synthesised wave", /window\.voice\.onLevel/.test(overlay));
ok("...and the main process forwards the level to it", /voice:level-out/.test(voice));
// Nothing may be focusable by default: an always-on-top panel that holds focus
// steals keystrokes meant for the app underneath, and a focused close button can
// be activated by a stray Enter — which is exactly what happened.
ok("no control is in the tab order", !/<button(?![^>]*tabindex="-1")/.test(overlay.replace(/<button[^>]*id="close"[^>]*>/g, "")));

// --- permissions route into the panel ---------------------------------------
ok("permission requests are captured during a voice session", /e\.type === "permission\.request"/.test(voice));
ok("...only during one", /if \(!session\) return; \/\/ typed sessions/.test(voice));
ok("...and are answered back through the bridge", /bridge\?\.answerPermission\?\.\(id, answer\)/.test(voice));
ok("multiple requests stack", /pendingPerms\.push/.test(voice));
ok("spoken allow/deny answers the top request", /ALLOW_RE\.test\(t\.text\)/.test(voice));
ok("ending the session denies anything still waiting", /for \(const p of \[\.\.\.pendingPerms\]\) answerPerm\(p\.id, "no"\)/.test(voice));

// --- echo suppression --------------------------------------------------------
const engineHtml = readFileSync(path.join(root, "electron", "voice-engine.html"), "utf8");
ok("a mute aborts a recording that is already running", /recordAbort = true/.test(engineHtml));
ok("...and the renderer confirms the mute back", /muteAck\(/.test(engineHtml));
ok("playback reports which clip ended", /playDone\(id, why\)/.test(engineHtml));
ok("the reopen timer is cancelled when more speech is queued", /cancelReopen\("more speech queued"\)/.test(voice));
ok("...and re-checks before reopening", /why: "still speaking"/.test(voice));
ok("listenAgain refuses while speech is in flight", /vlog\("record\.refused"/.test(voice));

console.log(fails ? `\n${fails} FAILED` : "\nall voice-session checks passed");
process.exit(fails ? 1 : 0);

// Verify (voice): silence must not become a turn, and closing the panel must not
// kill the wake word.
//
// Two bugs that presented as one complaint — "when I don't talk to it, it makes
// up words and keeps thinking it should wait, and after I close it I can't say
// hey jarvis again".
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const voice = readFileSync(path.join(root, "electron", "voice.js"), "utf8");

let fails = 0;
const ok = (n, c, d) => { console.log((c ? "PASS " : "FAIL ") + n + (d ? " — " + d : "")); if (!c) fails++; };

// --- 1. Whisper's silence artefacts -------------------------------------------
//
// Whisper does not return nothing for near-silence, it returns a sentence. Its
// training data is full of subtitled video, so what comes back for empty audio
// is whatever is most common at the end of one: "Thank you.", "Thanks for
// watching!", "you", a musical note. Those became real turns — the app answered
// them, spoke, reopened the mic, heard the room again, and appeared to sit there
// talking to itself.
//
// The function is lifted out of voice.js rather than reimplemented here: a copy
// of the list would drift from the one that ships, and this suite would then be
// testing itself.
const start = voice.indexOf("  const normalise = (text) =>");
const end = voice.indexOf("  async function handleUtterance");
ok("the filter is where the test expects it", start !== -1 && end > start);
const isSilenceArtefact = new Function(voice.slice(start, end) + "\nreturn isSilenceArtefact;")();

for (const t of [
  "you", "Thank you.", "Thank you very much.", "Thanks for watching!",
  "Bye.", "Goodbye.", "Okay.", "um", "uh", "Hmm.", "...", "♪", "   ", "",
  "Subtitles by the Amara.org community", "Amara.org", "Please subscribe",
]) {
  ok("discards " + JSON.stringify(t), isSilenceArtefact(t) === true);
}

// The other half, and the more important one. A short utterance is usually the
// most important kind, so nothing may be rejected for being brief — only for
// being one of the specific things Whisper says when handed silence.
for (const t of [
  "yes", "no", "stop", "hi", "stop listening", "open spotify",
  "how are you doing", "what is the capital of France",
  "thank you for the help", "you were right about that",
  "subscribe to the newsletter", "say goodbye to the old parser",
]) {
  ok("keeps " + JSON.stringify(t), isSilenceArtefact(t) === false);
}

// A discarded transcript is NOT an error: nobody spoke, so the panel must go
// back to listening rather than flashing a failure at the user.
ok("a discarded transcript returns to listening, not error",
  voice.includes('vlog("transcribe.discarded"') &&
  voice.includes('toOverlay("voice:state", { state: "listening", transcript: "", response: "" })'));

// --- 2. closing the overlay must end the session ------------------------------
//
// wake() opens with a guard that returns while a session is believed open. Every
// other exit clears that flag; closing the window itself did not, so the flag
// stayed set, and every later "hey jarvis" was heard, fired the detector, and
// did nothing — for the rest of the process's life.
{
  const at = voice.indexOf('overlay.on("closed"');
  ok("the overlay has a closed handler", at !== -1);
  const handler = voice.slice(at, at + 240);
  ok("...and closing it ends the session", handler.includes("endSession("));
  ok("...only when one is actually open", handler.includes("if (session)"));
}

// The wake guard is the reason the above matters; if it goes, this suite is
// asserting something that no longer protects anything.
ok("wake() still refuses to open a second session", /function wake\(\)\s*\{\s*\n\s*if \(session\) return;/.test(voice));

// endSession is what unmutes, via stopSpeaking — so a window closed mid-reply
// cannot leave the microphone deaf.
ok("ending a session stops speech (which unmutes the mic)",
  /function endSession[\s\S]{0,900}stopSpeaking\(/.test(voice));

// --- 3. the default model -----------------------------------------------------
{
  const startup = readFileSync(path.join(root, "src", "startup.ts"), "utf8");
  ok("the shipped default is glm-5.3-flash", /DEFAULT_MODEL = "z-ai\/glm-5\.3-flash"/.test(startup));
}

console.log(fails ? "\n" + fails + " FAILED" : "\nall voice silence/wake checks passed");
process.exit(fails ? 1 : 0);

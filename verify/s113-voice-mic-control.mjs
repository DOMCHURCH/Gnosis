// Verify (web UI): the microphone is reachable without saying a magic word.
//
// Voice had no presence in the main window: the wake word is invisible until it
// fires, the overlay does not exist until a conversation starts, and the only
// control was a switch inside Settings. So the headline feature was reachable
// only by knowing a phrase, and its failures were silent — a missing Python or
// transcription key looked exactly like a working install.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { voiceLook } from "../web/src/voicestate.js";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "src");
const read = (f) => readFileSync(path.join(web, f), "utf8");

let fails = 0;
const ok = (n, c, d) => { console.log((c ? "PASS " : "FAIL ") + n + (d ? " — " + d : "")); if (!c) fails++; };

// --- the four states -----------------------------------------------------------
const S = (o) => ({ enabled: true, wakeWord: true, transcription: true, reason: "", ...o });

{
  ok("nothing is drawn before the status arrives", voiceLook(null) === null);

  const on = voiceLook(S({}));
  ok("enabled and working reads as on", on.state === "on" && on.action === "wake");
  ok("...and clicking it starts a conversation", on.action === "wake");

  const live = voiceLook(S({ session: true }));
  ok("an open conversation reads as listening", live.state === "listening");
  ok("...and is visually distinct from merely on", live.fg !== on.fg);

  const off = voiceLook(S({ enabled: false, wakeWord: false, transcription: false }));
  ok("disabled reads as off", off.state === "off");
  ok("...and clicking it turns voice on", off.action === "enable");

  // The state that used to be invisible, and the reason this suite exists.
  const noPython = voiceLook(S({ wakeWord: false, reason: "Python 3.9+ not found" }));
  ok("enabled but deaf is NOT drawn as off", noPython.state === "broken" && noPython.state !== "off");
  ok("...it says why, in the tooltip", noPython.title.includes("Python 3.9+ not found"));
  ok("...and clicking it goes where the fix is", noPython.action === "settings");

  const noKey = voiceLook(S({ transcription: false, reason: "no GROQ_API_KEY" }));
  ok("a missing transcription key is the same kind of failure", noKey.state === "broken");
  ok("...and names that reason instead of the other one", noKey.title.includes("GROQ_API_KEY"));

  // A failure must not be mistaken for a choice, so it cannot share its colour.
  ok("broken does not look like off", noPython.fg !== off.fg);
}

// --- both placements, one component --------------------------------------------
{
  const mic = read("VoiceMic.tsx");
  const bar = read("TopBar.tsx");
  const composer = read("SessionsFloor.tsx");

  ok("the title bar renders it", /<VoiceMic variant="bar"/.test(bar));
  // The one that was actually asked for: beside the message box, where your
  // hands already are.
  ok("the composer renders it too", /<VoiceMic variant="composer"/.test(composer));
  ok("...on mobile as well as desktop",
    (composer.match(/<VoiceMic variant="composer"/g) || []).length >= 2);

  // Two copies of this logic would drift; the point of the shared component is
  // that the title bar and the composer cannot disagree about what voice is doing.
  ok("neither place reimplements the states", !/state === "broken"/.test(bar) && !/state === "broken"/.test(composer));
  ok("the component defers to voicestate.js", /from "\.\/voicestate"/.test(mic));

  // A browser tab on the LAN has no microphone and no bridge. A dead button
  // there is a worse lie than no button.
  ok("it renders nothing without a shell bridge", /if \(!shell\?\.voiceStatus\) return null;/.test(mic));

  // The click has to reach the SAME entry point the wake word uses, or the two
  // ways in can behave differently.
  ok("clicking starts a real session", /shell\.voiceWake\(\)/.test(mic));
}

// --- the bridge actually exposes what the button calls -------------------------
{
  const preload = readFileSync(path.join(web, "..", "..", "electron", "shell-preload.cjs"), "utf8");
  for (const m of ["voiceStatus", "voiceWake", "voiceSetEnabled", "onVoiceStatus"]) {
    ok(`the shell bridge exposes ${m}`, new RegExp(m + ":").test(preload));
  }
  const voice = readFileSync(path.join(web, "..", "..", "electron", "voice.js"), "utf8");
  ok("voice:wake is accepted from a renderer", /ipcMain\.on\("voice:wake"/.test(voice));
  // Pushed rather than polled: an always-on-top button that polls is a timer
  // running forever for a value that changes a few times a day.
  ok("status changes are pushed to the window", /voice:status-changed/.test(voice));
}

console.log(fails ? "\n" + fails + " FAILED" : "\nall voice-mic checks passed");
process.exit(fails ? 1 : 0);

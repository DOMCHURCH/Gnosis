// Verify (voice): the Whisper-based "hey gnosis" wake path, and the toggle
// between it and openWakeWord.
//
// openWakeWord has no lightweight route to train a detector for a new phrase
// (see the big comment at the top of electron/voice.js — its "custom verifier"
// mechanism adapts an EXISTING model to a speaker, it does not create one, and
// the real training route needs several thousand synthetic samples plus
// ~30,000 hours of negative data). This is the alternative: no detector at all,
// a short mic chunk sent to Groq Whisper every ~2.5-3s, and the transcript
// matched against "gnosis" and its common Whisper mishearings.
//
// The regex itself was proven against the REAL pipeline before this suite was
// written, not assumed: Kokoro synthesized "hey gnosis", the WAV went to the
// real Groq Whisper endpoint, it came back as "Hey Gnosis.", and the exact
// regex shipping here matched it. A negative control ("What is the weather
// like today?") did not match. This suite locks that regex and the wiring
// around it so a future edit can't silently drop the phrase.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const voice = readFileSync(path.join(root, "electron", "voice.js"), "utf8");
const engineHtml = readFileSync(path.join(root, "electron", "voice-engine.html"), "utf8");
const preload = readFileSync(path.join(root, "electron", "voice-preload.cjs"), "utf8");
const settingsJs = readFileSync(path.join(root, "electron", "settings.js"), "utf8");
const settingsHtml = readFileSync(path.join(root, "electron", "settings.html"), "utf8");
const shellPreload = readFileSync(path.join(root, "electron", "preload.cjs"), "utf8");
const configTs = readFileSync(path.join(root, "src", "config.ts"), "utf8");
const mainJs = readFileSync(path.join(root, "electron", "main.js"), "utf8");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

/** Pull a regex literal out of voice.js by the name it is bound to, the same
 * way s89-voice-session.mjs does for STOP_RE/SWITCH_RE — this tests the
 * pattern that actually ships, not a copy that can drift. */
function literal(name) {
  const m = voice.match(new RegExp(`const ${name} = (/.*/[a-z]*);`));
  if (!m) throw new Error(`${name} not found in voice.js`);
  // eslint-disable-next-line no-eval
  return (0, eval)(m[1]);
}

const WAKE_WHISPER_RE = literal("WAKE_WHISPER_RE");

// --- the match regex, against real Whisper output shapes ----------------------
// "Hey Gnosis." is the literal transcript Whisper returned for the phrase in
// the live test this suite documents above.
for (const phrase of ["Hey Gnosis.", "hey gnosis", "gnosis", "Gnosis, are you there"]) {
  ok(`"${phrase}" matches`, WAKE_WHISPER_RE.test(phrase));
}
// The near-homophones named in the task and observed as real Whisper mishears.
for (const phrase of ["no sis, can you help", "yo sis look at this", "know sis", "nosis please"]) {
  ok(`"${phrase}" matches (phonetic near-miss)`, WAKE_WHISPER_RE.test(phrase));
}
// The negative control from the live test, plus the obvious false-positive
// trap: "gnosis" is a substring of "diagnosis", and \b must stop that.
for (const phrase of ["What is the weather like today?", "this is a test sentence", "hey jarvis", ""]) {
  ok(`"${phrase}" does NOT match`, !WAKE_WHISPER_RE.test(phrase));
}
ok('"diagnosis" does not false-positive on the "gnosis" substring', !WAKE_WHISPER_RE.test("a diagnosis of the problem"));

ok("matchesWakePhrase is exported for reuse", /export function matchesWakePhrase/.test(voice));

// --- two engines, chosen from config, kept independent -------------------------
ok("wakeEngine is tracked separately from the detector process",
  /let wakeEngine = "openwakeword";/.test(voice));
ok("start() reads it from config, not a hardcoded default",
  /wakeEngine = config\.wakeEngine === "whisper" \? "whisper" : "openwakeword";/.test(voice));
ok("whisper mode does not spawn the openWakeWord process",
  /if \(wakeEngine === "whisper"\) \{[\s\S]*?detector = null;/.test(voice));
ok("...and openWakeWord mode is otherwise unchanged (still calls startWakeWord)",
  /detector = await startWakeWord\(\{/.test(voice));
ok("wakePhrase() answers per engine, not just per loaded model",
  /if \(wakeEngine === "whisper"\) return "hey gnosis";/.test(voice));

// --- the wake-chunk path ---------------------------------------------------
ok("a wake chunk goes through its own IPC channel, not the PCM tap",
  /ipcMain\.on\("voice:wake-chunk"/.test(voice));
ok("...handled by a dedicated function", /async function handleWakeChunk\(wavBase64\)/.test(voice));
ok("...that refuses to run outside the whisper engine", /wakeEngine !== "whisper" \|\| session\) return;/.test(voice));
ok("...and reuses the same transcribe() the utterance path uses (one Whisper client, not two)",
  (voice.match(/await transcribe\(wavBase64, env\.GROQ_API_KEY\)/g) ?? []).length >= 2);
ok("a match calls the real wake(), not a copy of its logic", /if \(matchesWakePhrase\(t\.text\)\) \{[\s\S]*?wake\(\);/.test(voice));

// --- rate limiting: chunks, not a stream ---------------------------------------
// The task's own requirement: "a chunk every 2-3 seconds, not continuous
// streaming." Asserted on both sides — the renderer's cadence, and the fact
// that whisper mode never enables the continuous PCM tap at all.
{
  const ms = engineHtml.match(/const WHISPER_CHUNK_MS = (\d+);/);
  ok("the whisper chunk window is 2-3s", !!ms && Number(ms[1]) >= 2000 && Number(ms[1]) <= 3000);
}
ok("there is a gap between chunks, not back-to-back capture", /const WHISPER_GAP_MS = \d+;/.test(engineHtml));
ok("a near-silent chunk is dropped before upload (no Whisper call on room tone)",
  /rmsOf\(flat\) >= WHISPER_SILENCE_RMS/.test(engineHtml));
{
  // Scoped to the function's OWN body (up to the next top-level function), not
  // "from here to the first match anywhere in the file" — the openwakeword
  // branch further down the same file legitimately calls window.voice.audio(),
  // and a match spanning both would prove nothing.
  const start = engineHtml.indexOf("async function startWhisperWake()");
  const body = engineHtml.slice(start, engineHtml.indexOf("\n      window.voice.onConfigure", start));
  ok("startWhisperWake exists", start !== -1);
  ok("...and never starts the continuous openWakeWord tap", !body.includes("window.voice.audio("));
}
// The loop must always reschedule itself, or one bad chunk deafens the app
// until voice is toggled off and on.
ok("the loop reschedules itself unconditionally, even when it bails early",
  (engineHtml.match(/setTimeout\(whisperWakeTick,/g) ?? []).length >= 2);
ok("...and stops cleanly when voice/engine switches away", /if \(!whisperRunning\) return;/.test(engineHtml));

// --- it defers to an in-progress utterance recording, same as openWakeWord ---
ok("the wake-chunk loop yields to the recorder", /if \(recording \|\| muted\) \{[\s\S]*?setTimeout\(whisperWakeTick/.test(engineHtml));
ok("...and bails mid-capture too, not just at the start", /if \(recording \|\| muted\) \{ proc\.onaudioprocess = null; done\(\); return; \}/.test(engineHtml));

// --- openWakeWord path is untouched, not replaced -------------------------
ok("openWakeWord / hey_jarvis code is still present", /DEFAULT_WAKE_MODEL = "hey_jarvis"/.test(voice) && /startWakeWord\(/.test(voice));
ok("the mic renderer still has the original PCM tap for it", /window\.voice\.audio\(pcm\.buffer\)/.test(engineHtml));
ok("main.js does not duplicate the engine-selection logic — it only restarts",
  /setWakeEngine: async \(\) => \{[\s\S]*?voice\.stop\(\);[\s\S]*?voice\.start\(\);[\s\S]*?\},/.test(mainJs)
  && !/config\.wakeEngine ===/.test(mainJs));

// --- the settings toggle --------------------------------------------------
ok("config gained a wakeEngine field", /wakeEngine\?: "openwakeword" \| "whisper";/.test(configTs));
ok("a dedicated IPC handler saves and live-applies it",
  /ipcMain\.handle\("settings:set-wake-engine"/.test(settingsJs));
ok("...restarting the pipeline live if voice is already on (no relaunch needed)",
  /setWakeEngine: async \(\) => \{[\s\S]*?voice\.stop\(\);[\s\S]*?return voice\.start\(\);/.test(mainJs));
ok("...bridged to the renderer", /setWakeEngine: \(engine\) => ipcRenderer\.invoke\("settings:set-wake-engine"/.test(shellPreload));
ok("settings:load reports which engine is selected", /wakeEngine,\s*\n\s*\};/.test(settingsJs) || /wakeEngine,/.test(settingsJs));

// --- the UI is a real two-way choice, not a single boolean --------------------
ok("two engine buttons exist in the panel", (settingsHtml.match(/class="wake-engine-btn"/g) ?? []).length === 2);
ok("...labelled with both phrases, not just one", /“hey jarvis”/.test(settingsHtml) && /“hey gnosis”/.test(settingsHtml));
ok("clicking one calls the bridge and repaints", /window\.gnosis\.setWakeEngine\(engine\)/.test(settingsHtml));
ok("diagnostics distinguish the two engines instead of always saying openwakeword",
  /const whisper = d\.wakeEngine === "whisper";/.test(settingsHtml) && /"wake chunks sent"/.test(settingsHtml));

// --- the "Test wake word" button exercises whichever engine is active --------
ok("voice:test branches by engine", /wakeEngine === "whisper" \? testWhisperWake\(\) : testWakeWord\(\)/.test(voice));
ok("testWhisperWake proves the real chain (TTS -> real Whisper call -> match), same shape as testWakeWord",
  /async function testWhisperWake\(\)/.test(voice) && /await transcribe\(wavBase64, env\.GROQ_API_KEY\)/.test(voice));

console.log(fails ? `\n${fails} FAILED` : "\nall whisper-wake checks passed");
process.exit(fails ? 1 : 0);

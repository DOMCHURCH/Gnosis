// Verify (voice capture): a whisper actually reaches the transcriber.
//
// Reported plainly: "it should hear me when I am whispering". It could not, for
// three independent reasons, and each one alone was enough to lose the audio:
//
//   1. The speech gate was a flat `SILENCE_RMS = 0.012`. A whisper measures
//      ~0.002-0.010 RMS, so it sat entirely below the gate; `heardAnything`
//      stayed false and the recorder discarded the utterance as silence. It was
//      never a transcription-quality problem — the audio never got that far.
//   2. `noiseSuppression: true` on getUserMedia. Chromium's suppressor is a
//      spectral gate tuned to remove steady low-level signal, which describes a
//      whisper exactly. It was erased in the browser before any threshold of
//      ours could see it, so lowering (1) alone would have fixed nothing.
//   3. The wake-word threshold was 0.5. openWakeWord scores quiet speech well
//      below that, so a whispered "hey jarvis" never opened a session at all.
//
// The replacement for (1) is an adaptive floor, and the risk it introduces is
// the opposite failure: a gate that drifts up during a long sentence and cuts
// the speaker off mid-utterance. Section 2 pins that it cannot.
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engine = readFileSync(path.join(root, "electron", "voice-engine.html"), "utf8");
const wake = readFileSync(path.join(root, "electron", "wakeword.js"), "utf8");

let fails = 0;
const ok = (n, c, extra = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${extra ? ` — ${extra}` : ""}`); if (!c) fails++; };

// Rebuild the gate from the constants in the file, so this tests the shipped
// numbers rather than a copy of them that can drift.
const num = (name) => {
  const m = new RegExp(`const ${name} = ([\\d.]+)`).exec(engine);
  return m ? Number(m[1]) : NaN;
};
const GATE_MULT = num("GATE_MULT");
const GATE_MIN = num("GATE_MIN");
const GATE_MAX = num("GATE_MAX");

function makeGate() {
  let noiseFloor = 0.01;
  return {
    get floor() { return noiseFloor; },
    gate: () => Math.min(GATE_MAX, Math.max(GATE_MIN, noiseFloor * GATE_MULT)),
    track(level) {
      const a = level < noiseFloor ? 0.05 : 0.002;
      noiseFloor += (level - noiseFloor) * a;
      if (!(noiseFloor > 0)) noiseFloor = GATE_MIN;
    },
  };
}

/** Feed `seconds` of room tone at `level`, the way the recorder would. */
function settle(g, level, seconds = 20) {
  // onaudioprocess fires roughly every 256/16000s; 60/s is a fair stand-in.
  for (let i = 0; i < seconds * 60; i++) if (level <= g.gate()) g.track(level);
}

// --- 1. a whisper is heard in a quiet room ----------------------------------
{
  ok("the constants parse", [GATE_MULT, GATE_MIN, GATE_MAX].every(Number.isFinite),
    `mult=${GATE_MULT} min=${GATE_MIN} max=${GATE_MAX}`);

  const g = makeGate();
  settle(g, 0.0008); // a quiet room on a decent mic
  const gate = g.gate();
  ok("the gate settles to the absolute floor in a quiet room", gate <= GATE_MIN + 1e-9, `gate=${gate.toFixed(5)}`);
  // Real whisper RMS, measured range.
  for (const w of [0.003, 0.005, 0.008, 0.01]) {
    ok(`a whisper at RMS ${w} registers as speech`, w > gate, `gate=${gate.toFixed(5)}`);
  }
  // And the old fixed gate would have thrown all of those away.
  ok("...all of which the old fixed 0.012 gate discarded", [0.003, 0.005, 0.008, 0.01].every((w) => w < 0.012));
}

// --- 2. it must not cut the speaker off -------------------------------------
// The failure an adaptive gate invites: speech lifts the floor, the floor lifts
// the gate above the speaker's own voice, and recording stops mid-sentence.
{
  const g = makeGate();
  settle(g, 0.0008);
  const before = g.gate();
  // 10 seconds of continuous speech. Only sub-gate audio feeds the floor, which
  // is the property that makes this safe.
  for (let i = 0; i < 10 * 60; i++) {
    const level = 0.05;
    if (level > g.gate()) { /* speech: does not touch the floor */ } else g.track(level);
  }
  ok("sustained speech does not raise the gate", g.gate() <= before + 1e-9,
    `${before.toFixed(5)} -> ${g.gate().toFixed(5)}`);
  ok("...so a long sentence is never cut off", 0.05 > g.gate());
  // A whisper immediately after loud speech still registers.
  ok("...and a whisper right after loud speech still registers", 0.004 > g.gate());
}

// --- 3. a noisy room raises the gate instead of hearing noise ---------------
{
  const g = makeGate();
  settle(g, 0.02, 60); // a loud room: fan, traffic
  ok("a noisy room lifts the gate above the noise", g.gate() > 0.008, `gate=${g.gate().toFixed(5)}`);
  ok("...but never past the cap", g.gate() <= GATE_MAX + 1e-9);
  // Coming back to quiet must recover, or one loud moment deafens the session.
  settle(g, 0.0008, 30);
  ok("returning to quiet restores whisper sensitivity", 0.004 > g.gate(), `gate=${g.gate().toFixed(5)}`);
}

// --- 4. the browser must stop erasing the whisper first ---------------------
{
  ok("noiseSuppression is OFF (it deletes whispers)", /noiseSuppression: false/.test(engine));
  ok("autoGainControl is ON (lifts quiet speech for Whisper)", /autoGainControl: true/.test(engine));
  // Echo cancellation is load-bearing for the reply-loop fix and must stay.
  ok("echoCancellation is still ON", /echoCancellation: true/.test(engine));
  // The old fixed gate must be gone, not merely lowered.
  ok("the fixed SILENCE_RMS gate is gone", !/const SILENCE_RMS/.test(engine));
  ok("the recorder uses the adaptive gate", /const gate = speechGate\(\);/.test(engine));
  ok("...and only feeds sub-gate audio to the floor", /else trackNoise\(level\)/.test(engine));
}

// --- 5. the wake word has to hear it too ------------------------------------
// Capturing a whisper is useless if the phrase that starts the session cannot be
// whispered in the first place.
{
  const m = /const DEFAULT_THRESHOLD = Number\(process\.env\.GNOSIS_WAKE_THRESHOLD\) \|\| ([\d.]+)/.exec(wake);
  const t = m ? Number(m[1]) : NaN;
  ok("the wake threshold is lowered for quiet speech", Number.isFinite(t) && t < 0.5, `${t}`);
  ok("...but not into false-wake territory", Number.isFinite(t) && t >= 0.3, `${t}`);
  ok("...and is still overridable per room", /GNOSIS_WAKE_THRESHOLD/.test(wake));
}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

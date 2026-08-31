// Verify (voice): the per-turn timing log actually gets written, and reports the
// whole turn rather than its last sentence.
//
// This suite exists because the first version of the instrumentation was wired
// to a branch that essentially never ran: writeTurnTiming was called only when a
// turn ended with no leftover text AND the speech queue was already drained,
// which is not what a spoken reply looks like. It shipped, the user spoke two
// turns, and ~/.dom/voice-timing.log did not exist. A measurement that never
// fires is indistinguishable from a pipeline that is fast, so the wiring itself
// is what has to be asserted — not just the arithmetic.
//
// voice.js needs Electron to import, so summariseTurn is lifted out of the
// source text and the call sites are asserted structurally.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "electron", "voice.js"),
  "utf8",
);

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- the wiring: does the timing ever get written? -----------------------------
{
  // The drain is the only place that knows the audio has finished. If the write
  // moves back out of it, the log goes empty again and nothing else notices.
  const drain = src.slice(src.indexOf("async function drainSpeech()"), src.indexOf("function scheduleReopen()"));
  ok("the speech drain writes the turn timing", /writeTurnTiming\(timeline\)/.test(drain));
  ok("...only once the queue is empty", /!speech\.queue\.length/.test(drain));
  ok("...and only for a turn the model has finished", /turnEnded/.test(drain));

  // The other half of the handshake: the gate has to raise the flag the drain
  // reads, on every path where a turn ends with something to say.
  const gate = src.slice(src.indexOf("const gate = createReplyGate("), src.indexOf("bridge?.bus?.subscribe"));
  ok("the reply gate marks the turn ended", /turnEnded = true/.test(gate));

  // Synthesis runs a sentence ahead of playback, so the gap between sentences
  // is not a full synth of silence. The ordering is the whole fix: start the
  // next synth BEFORE awaiting this one's playback, or nothing overlaps.
  const nextSynth = drain.indexOf("ahead = synth(speech.queue.shift())");
  const awaitPlay = drain.indexOf("await playAndWait");
  ok("the next sentence starts synthesising before the current one plays",
    nextSynth !== -1 && awaitPlay !== -1 && nextSynth < awaitPlay);

  // A turn cut off mid-sentence has no honest total, and must not be logged as
  // if it completed — nor leave the flag set for the next turn to trip over.
  const stop = src.slice(src.indexOf("function stopSpeaking(why)"), src.indexOf("function stopSpeaking(why)") + 500);
  ok("a stopped turn clears the flag", /turnEnded = false/.test(stop));
}

// --- the arithmetic: does it describe the turn correctly? ----------------------
const start = src.indexOf("function summariseTurn(timeline) {");
const summariseTurn = new Function(src.slice(start, src.indexOf("async function writeTurnTiming")) + "\nreturn summariseTurn;")();

const t = 1000;
// A real reply is spoken sentence by sentence: two synth/play pairs, not one.
const turn = [
  { at: t +    0, event: "record.start" },
  { at: t + 1200, event: "utterance.received" },
  { at: t + 1210, event: "transcribe.start" },
  { at: t + 1610, event: "transcribe.end" },
  { at: t + 3710, event: "tts.queued" },
  { at: t + 3720, event: "tts.synth.start" },
  { at: t + 4120, event: "tts.synth.end" },
  { at: t + 4130, event: "tts.play.start" },
  { at: t + 5130, event: "tts.play.end" },
  { at: t + 5140, event: "tts.queued" },
  { at: t + 5150, event: "tts.synth.start" },
  { at: t + 5450, event: "tts.synth.end" },
  { at: t + 5460, event: "tts.play.start" },
  { at: t + 6360, event: "tts.play.end" },
];

{
  const s = summariseTurn(turn);
  ok("listen is the wake word to the end of the utterance", s.stages.listen === 1200);
  ok("transcribe is the STT call", s.stages.transcribe === 400);
  ok("model is the gap before the first spoken sentence", s.stages.model === 2100);
  // The bug this replaced reported 300 here — the last sentence only.
  ok("synth sums every sentence, not just the last", s.stages.synth === 700);
  ok("play sums every clip, not just the last", s.stages.play === 1900);
  ok("total runs from the wake word to the last word spoken", s.total === 6360);
}

{
  // The timeline is a rolling buffer of up to 400 events, so it still holds the
  // previous turn's audio. Summing blindly would charge this turn for it.
  const s = summariseTurn([
    { at: 0, event: "record.start" },
    { at: 10, event: "tts.synth.start" },
    { at: 5000, event: "tts.synth.end" },
    ...turn,
  ]);
  ok("an earlier turn's audio is not counted", s.stages.synth === 700);
}

{
  /*
   * The microphone reopens the moment the speech queue drains, which for a
   * multi-sentence reply happens while the turn is still speaking. That puts a
   * record.start INSIDE the turn, newer than the one that started it.
   *
   * Anchoring on the newest one measured the turn from a point inside itself:
   * a real turn logged "total 5.99s" while its own stages summed past ten, with
   * no listen stage at all. A total shorter than its parts is not a slow turn
   * reported badly, it is a number that means nothing.
   */
  const reopened = [
    ...turn.slice(0, 9),                          // through the first sentence playing
    { at: t + 5135, event: "record.start" },      // mic reopens mid-turn
    ...turn.slice(9),                             // the rest of the same reply
  ];
  const s = summariseTurn(reopened);
  ok("a mid-turn mic reopen does not become the start of the turn", s.total === 6360);
  ok("...and the listen stage survives it", s.stages.listen === 1200);
  // The guard is the transcript: a record.start after it belongs to the NEXT
  // turn, and one before it is the recording that produced this transcript.
  ok("...and the turn is still anchored before its own transcript", s.stages.transcribe === 400);
}

{
  // Nothing said yet: the settings panel reads this timeline too, and a startup
  // with no turn in it must not produce a log line about a turn that never was.
  ok("an empty timeline summarises to nothing", summariseTurn([]) === null);
  ok("a timeline with no recording summarises to nothing", summariseTurn([{ at: 1, event: "tts.queued" }]) === null);
}

console.log(fails ? `\n${fails} FAILED` : "\nall voice-timing checks passed");
process.exit(fails ? 1 : 0);

// Verify (voice): TTS only speaks a turn the wake word armed.
//
// The claim being tested is a negative one — "typing into the chat does not make
// the app talk" — and a negative is exactly the kind of thing that quietly stops
// being true. The gate is a separate module from voice.js precisely so it can be
// driven here without Electron: these push real bus events through it and assert
// on whether anything was spoken.
//
// The events are the ones servehost.ts actually emits (mirrorCallbacks), so a
// change to the wire shape breaks this rather than passing on a shape nobody
// sends any more.
import { createReplyGate, speakableReply, takeSentences } from "../electron/voicegate.js";

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

/** A gate plus a log of everything it decided to say. */
function harness() {
  const spoken = [];
  const silent = [];
  const gate = createReplyGate((r) => spoken.push(r), () => silent.push(true));
  return { gate, spoken, silent };
}

const assistant = (tabId, text) => ({ type: "line", tabId, item: { kind: "line", text } });
const turnEnd = (tabId) => ({ type: "turn.end", tabId, cost: 0, tokens: 0, cachedTokens: 0 });

// --- the negative: a typed message is silent -----------------------------------
{
  const { gate, spoken } = harness();
  // Nobody said the wake word, so the gate was never armed. This is the exact
  // sequence a chat message produces.
  gate.handle({ type: "line", tabId: 0, item: { kind: "user", text: "what does this repo do?" } });
  gate.handle(assistant(0, "It is a terminal coding agent."));
  gate.handle(turnEnd(0));
  ok("a typed chat turn speaks nothing", spoken.length === 0);
  ok("...and leaves the gate disarmed", gate.armed === false);
}

// --- the positive: a wake-word turn speaks -------------------------------------
{
  const { gate, spoken } = harness();
  gate.arm(0);
  ok("arming the gate arms it", gate.armed === true);
  gate.handle({ type: "line", tabId: 0, item: { kind: "user", text: "[voice] what time is it" } });
  gate.handle(assistant(0, "It is just past six."));
  gate.handle(turnEnd(0));
  ok("a wake-word turn is spoken", spoken.length === 1);
  ok("...with the assistant's own words", spoken[0] === "It is just past six.");
  ok("...and disarms itself afterwards", gate.armed === false);
}

// --- only the tab that was spoken to -------------------------------------------
{
  const { gate, spoken } = harness();
  gate.arm(0);
  // A background agent on another tab finishing mid-conversation must not talk.
  gate.handle(assistant(3, "Background agent finished the migration."));
  gate.handle(turnEnd(3));
  ok("another tab's lines are ignored", spoken.length === 0);
  ok("...and its turn.end does not disarm the gate", gate.armed === true);
  gate.handle(assistant(0, "Here is your answer."));
  gate.handle(turnEnd(0));
  ok("the armed tab still speaks", spoken.length === 1 && spoken[0] === "Here is your answer.");
}

// --- one turn only -------------------------------------------------------------
{
  const { gate, spoken } = harness();
  gate.arm(0);
  gate.handle(assistant(0, "First answer."));
  gate.handle(turnEnd(0));
  // The user now types a follow-up rather than speaking it.
  gate.handle(assistant(0, "Second answer."));
  gate.handle(turnEnd(0));
  ok("the turn after a spoken one is silent", spoken.length === 1 && spoken[0] === "First answer.");
}

// --- what counts as a reply ----------------------------------------------------
{
  const { gate, spoken, silent } = harness();
  gate.arm(0);
  // System chrome, the echo of the user's own words, and a code-fence marker.
  gate.handle({ type: "line", tabId: 0, item: { kind: "system", text: "⎿ aborted" } });
  gate.handle({ type: "line", tabId: 0, item: { kind: "user", text: "[voice] hello" } });
  gate.handle({ type: "line", tabId: 0, item: { kind: "rule", lang: "js" } });
  gate.handle(turnEnd(0));
  ok("a turn with no assistant prose speaks nothing", spoken.length === 0);
  ok("...and reports itself silent so the overlay closes", silent.length === 1);
}

// --- disarm ---------------------------------------------------------------------
{
  const { gate, spoken } = harness();
  gate.arm(0);
  gate.handle(assistant(0, "Half an answer."));
  gate.disarm(); // the user cancelled, or turned voice off
  gate.handle(turnEnd(0));
  ok("a cancelled voice turn speaks nothing", spoken.length === 0);
}

// --- the text that gets spoken ---------------------------------------------------
ok("lines are joined into one utterance", speakableReply(["One.", "Two."]) === "One. Two.");
ok("whitespace is collapsed", speakableReply(["a  \n  b"]) === "a b");
ok("nothing to say is empty", speakableReply([]) === "");
ok("blank lines are empty", speakableReply(["   ", "\n"]) === "");
{
  // A whole turn read aloud is a minute of speech; it is capped on a word boundary.
  const long = speakableReply([`${"word ".repeat(200)}`]);
  ok("a long reply is capped", long.length <= 401);
  ok("...on a word boundary, with an ellipsis", long.endsWith("…") && !long.includes("wor…"));
}

// --- streaming: sentences are handed over as they finish ----------------------
// Waiting for turn.end meant the user heard nothing until the whole reply had
// been generated. These assert the split, because a bad one either fragments
// speech at every abbreviation or never emits until the end.
{
  const t = (s) => takeSentences(s);
  ok("a complete sentence is taken", t("This is a whole sentence. ").chunks[0] === "This is a whole sentence.");
  ok("...and the remainder is kept", t("One sentence here. And a part").rest === "And a part");
  ok("a lowercase continuation is not a sentence break", t("Version v1.2 is out. it says").chunks.length <= 1);
  ok("an unfinished sentence is not spoken early", t("This has no terminator yet").chunks.length === 0);
  ok("two sentences come out as two", t("First one here. Second one here. ").chunks.length === 2);
  ok("a question mark ends a sentence", t("Are you sure about that? ").chunks.length === 1);
  // The reason for the minimum length: an abbreviation is not a sentence.
  ok("an abbreviation does not split the line", t("Use a flag, e.g. --force, to do it. ").chunks.length === 1);
  ok("...and that sentence stays intact", t("Use a flag, e.g. --force, to do it. ").chunks[0] === "Use a flag, e.g. --force, to do it.");
}

{
  // The gate in streaming mode: chunks during the turn, leftover at the end.
  const spokenChunks = [];
  const finals = [];
  const gate = createReplyGate((r) => finals.push(r), () => finals.push(null), (c) => spokenChunks.push(c));
  gate.arm(0);
  gate.handle(assistant(0, "I looked at the repo."));
  ok("the first sentence is spoken before the turn ends", spokenChunks.length === 1);
  gate.handle(assistant(0, "It has 118 test suites."));
  ok("...and so is the second", spokenChunks.length === 2);
  gate.handle(assistant(0, "No trailing stop here"));
  ok("an unterminated tail is not spoken yet", spokenChunks.length === 2);
  gate.handle(turnEnd(0));
  ok("...it is spoken at the end", finals[0] === "No trailing stop here");
}

{
  // A streamed turn ending exactly on a full stop has nothing left over, and must
  // NOT be reported as silent — it spoke.
  const finals = [];
  const silent = [];
  const gate = createReplyGate((r) => finals.push(r), () => silent.push(true), () => {});
  gate.arm(0);
  gate.handle(assistant(0, "All done."));
  gate.handle(turnEnd(0));
  ok("a fully-streamed turn is not reported as silent", silent.length === 0);
}

console.log(fails ? `\n${fails} FAILED` : "\nall voice-gating checks passed");
process.exit(fails ? 1 : 0);

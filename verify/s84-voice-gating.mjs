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
import { createReplyGate, speakableReply } from "../electron/voicegate.js";

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

console.log(fails ? `\n${fails} FAILED` : "\nall voice-gating checks passed");
process.exit(fails ? 1 : 0);

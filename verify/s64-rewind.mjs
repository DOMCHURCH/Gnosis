// Verify (surgical rewind): turn boundaries, the two opposite operations, and the
// invariant that matters most — neither operation may leave a tool result whose
// originating assistant call has been removed, which the provider rejects.
import { turnMarks, recentTurns, rewindTo, splitForSummary, applyRewind, applySummary, summaryPrompt, summaryMessage } from "../dist/rewind.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const history = [
  { role: "user", text: "first thing" },
  { role: "assistant", text: "doing it", calls: [{ id: "c1", name: "write", args: "{}" }] },
  { role: "tool", callId: "c1", name: "write", result: "ok", isError: false },
  { role: "assistant", text: "done" },
  { role: "user", text: "second thing" },
  { role: "assistant", text: "on it" },
  { role: "user", text: "third thing" },
  { role: "assistant", text: "finished" },
];

// --- turn boundaries ----------------------------------------------------------
const marks = turnMarks(history);
ok("one mark per user message", marks.length === 3);
ok("marks are numbered from 1", marks[0].number === 1 && marks[2].number === 3);
ok("marks point at the user message", marks[1].index === 4);
ok("a turn owns the assistant + tool messages that follow it", marks[0].length === 4);
ok("the last turn runs to the end", marks[2].length === 2);
ok("summaries are one line", marks[0].summary === "first thing");
ok("empty history yields no marks", turnMarks([]).length === 0);

const longText = { role: "user", text: "x".repeat(500) };
ok("a long message is truncated for the picker", turnMarks([longText])[0].summary.length <= 72);
ok("newlines are flattened", turnMarks([{ role: "user", text: "a\n\nb" }])[0].summary === "a b");

// --- recentTurns --------------------------------------------------------------
const many = Array.from({ length: 30 }, (_, i) => ({ role: "user", text: `turn ${i}` }));
ok("recentTurns caps at 20", recentTurns(many, 20).length === 20);
ok("...keeping the MOST recent", recentTurns(many, 20)[19].summary === "turn 29");
ok("fewer turns than the cap returns them all", recentTurns(history, 20).length === 3);

// --- rewind: drops the named turn and everything after ------------------------
const rewound = applyRewind(history, marks[1]);
ok("rewind drops the named turn itself", rewound.messages.length === 4);
ok("...keeping everything before it", rewound.messages[3].text === "done");
ok("...and says how much it dropped", /dropped 4 message/.test(rewound.note));
ok("rewinding to turn 1 empties the history", applyRewind(history, marks[0]).messages.length === 0);

// The invariant: no orphaned tool result.
for (const [label, msgs] of [["rewind", rewound.messages]]) {
  const callIds = new Set(msgs.flatMap((m) => (m.role === "assistant" ? (m.calls ?? []).map((c) => c.id) : [])));
  const orphans = msgs.filter((m) => m.role === "tool" && !callIds.has(m.callId));
  ok(`${label} leaves no orphaned tool result`, orphans.length === 0);
}
ok("an out-of-range index is a no-op", rewindTo(history, 999).length === history.length);
ok("a negative index is a no-op", rewindTo(history, -1).length === history.length);

// --- summarize: compresses the head, keeps the tail verbatim ------------------
const split = splitForSummary(history, marks[2].index);
ok("the head is everything before the turn", split.head.length === 6);
ok("the tail starts AT the turn", split.tail[0].text === "third thing");

const summarized = applySummary(history, marks[2], "notes about the first two turns");
ok("summarize replaces the head with one message", summarized.messages.length === 3);
ok("...which is a user-role block", summarized.messages[0].role === "user");
ok("...carrying the summary text", summarized.messages[0].text.includes("notes about the first two turns"));
ok("...and labelled as a summary", /Summary of the first 2 turn/.test(summarized.messages[0].text));
ok("the tail survives verbatim", summarized.messages[1].text === "third thing" && summarized.messages[2].text === "finished");
ok("...and says what it did", /summarized 2 turn/.test(summarized.note));

const sumOrphans = (() => {
  const callIds = new Set(summarized.messages.flatMap((m) => (m.role === "assistant" ? (m.calls ?? []).map((c) => c.id) : [])));
  return summarized.messages.filter((m) => m.role === "tool" && !callIds.has(m.callId)).length;
})();
ok("summarize leaves no orphaned tool result", sumOrphans === 0);
ok("summarizing at turn 1 is a no-op", applySummary(history, marks[0], "x").messages.length === history.length);

// --- the two are genuinely opposite -------------------------------------------
ok("rewind shrinks from the tail, summarize from the head",
  applyRewind(history, marks[2]).messages[0].text === "first thing" &&
  applySummary(history, marks[2], "x").messages.at(-1).text === "finished");

// --- the summary prompt asks for what survives a handover ---------------------
const prompt = summaryPrompt(history.slice(0, 4));
ok("the prompt names the four things to preserve", /objective/.test(prompt) && /file path/.test(prompt) && /decisions/.test(prompt) && /did NOT work/.test(prompt));
ok("the prompt includes the transcript", /first thing/.test(prompt));
ok("tool calls are named in the transcript", /tools: write/.test(prompt));
ok("the summary block is a user message", summaryMessage("s", 3).role === "user");

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

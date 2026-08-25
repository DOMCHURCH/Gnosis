// Verify (ask_user): the tool refuses where there is nobody to ask rather than
// hanging, caps its option list, survives a timeout with usable guidance, and
// resolves through the bridge's first-to-answer registry the same way permissions
// do (so the TUI overlay and a browser card can race and the winner settles).
import { TOOLS } from "../dist/tools/index.js";
import { EventBus, createBridge } from "../dist/events.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const tool = TOOLS.ask_user;
ok("ask_user is registered", !!tool);
// It writes nothing, so it must not go through the permission gate — its own
// prompt is the confirmation.
ok("ask_user is non-mutating (skips the permission gate)", tool.mutating === false);

// --- no asker available (headless run, or inside a sub-agent) ----------------
const refused = await tool.run({ question: "A or B?" }, undefined, { cwd: "." });
ok("refuses when there is no user to ask", refused.isError === true);
ok("...and tells the model to state an assumption instead", /assumption|continue/i.test(refused.output));

// --- normal answer ------------------------------------------------------------
const answered = await tool.run(
  { question: "A or B?", options: ["A", "B"] },
  undefined,
  { cwd: ".", askUser: async (_q, opts) => ({ text: opts[1] }) },
);
ok("returns the user's answer to the model", answered.isError === false && answered.output.includes("B"));

// --- the option list is capped so a runaway model can't render 50 buttons ------
let seen = -1;
await tool.run(
  { question: "q", options: ["1", "2", "3", "4", "5", "6", "7"] },
  undefined,
  { cwd: ".", askUser: async (_q, opts) => { seen = opts.length; return { text: "x" }; } },
);
ok("option list is capped at 5", seen === 5);

// --- timeout (a question that nobody answered) --------------------------------
const timedOut = await tool.run(
  { question: "A or B?", options: ["A", "B"] },
  undefined,
  { cwd: ".", askUser: async () => ({ text: "", timedOut: true }) },
);
ok("a timeout is not an error", timedOut.isError === false);
ok("...and tells the agent to proceed on its own judgement", /best judgement/i.test(timedOut.output));

// --- an empty question is rejected before any UI is disturbed -----------------
const empty = await tool.run({ question: "   " }, undefined, { cwd: ".", askUser: async () => ({ text: "x" }) });
ok("an empty question is rejected", empty.isError === true);

// --- bridge: first answer wins, and only once ---------------------------------
const bridge = createBridge(new EventBus());
let resolved = [];
bridge.registerAsk("ask:1", (a) => resolved.push(a));
bridge.answerAsk("ask:1", "from the browser");
ok("a registered ask resolves with the client's answer", resolved[0] === "from the browser");
bridge.clearAsk("ask:1");
bridge.answerAsk("ask:1", "late second answer");
ok("a cleared ask ignores a late second answer", resolved.length === 1);
ok("answering an unknown id is a no-op, not a throw", (() => { try { bridge.answerAsk("nope", "x"); return true; } catch { return false; } })());

// --- the bus carries the question to browsers ---------------------------------
const bus = new EventBus();
const seenEvents = [];
bus.subscribe((e) => seenEvents.push(e));
bus.emit({ type: "ask.request", tabId: 1, id: "ask:1", question: "A or B?", options: ["A", "B"] });
bus.emit({ type: "ask.resolved", tabId: 1, id: "ask:1", answer: "A" });
ok("ask.request reaches subscribers with question + options", seenEvents[0]?.question === "A or B?" && seenEvents[0]?.options.length === 2);
ok("ask.resolved carries the answer", seenEvents[1]?.answer === "A");

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

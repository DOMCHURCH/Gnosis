// Verify (automatic outcome evaluation): the verdict parser handles the confidence
// the verifier is asked for, degrades gracefully when it forgets, and the inline
// line + fix-it follow-up read correctly.
import { parseVerdict, outcomeLine, outcomeFixPrompt } from "../dist/engine.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

// --- the happy shapes ---------------------------------------------------------
const pass = parseVerdict("PASS 94\ntests pass, types clean");
ok("PASS is read as a pass", pass.verdict === "pass");
ok("confidence is parsed", pass.confidence === 94);
ok("the sentence becomes the summary", pass.summary === "tests pass, types clean");

const fail = parseVerdict("FAIL 71\nmissing error handling in fetchUser");
ok("FAIL is read as a fail", fail.verdict === "fail");
ok("confidence is parsed on a fail", fail.confidence === 71);

// --- tolerance ----------------------------------------------------------------
ok("a verdict with no confidence still parses", parseVerdict("PASS\nlooks right").confidence === null);
ok("...and keeps its verdict", parseVerdict("PASS\nlooks right").verdict === "pass");
ok("lowercase is accepted", parseVerdict("pass 80\nfine").verdict === "pass");
ok("specifics trailing the verdict on one line are used", parseVerdict("FAIL 20 - nothing was written").summary === "nothing was written");
ok("an out-of-range confidence is dropped, not trusted", parseVerdict("PASS 900\nok").confidence === null);
ok("garbage is unknown, never silently a pass", parseVerdict("I think it's fine?").verdict === "unknown");
ok("empty input is unknown", parseVerdict("").verdict === "unknown");
ok("PASSPORT does not count as PASS", parseVerdict("PASSPORT renewed").verdict === "unknown");
ok("a long summary is capped", parseVerdict("FAIL 50\n" + "x".repeat(500)).summary.length <= 300);

// --- the inline line ----------------------------------------------------------
ok("a pass line reads as specified", outcomeLine(pass) === "✓ outcome: tests pass, types clean (94% confidence)");
ok("a fail line reads as specified", outcomeLine(fail) === "✗ outcome: missing error handling in fetchUser (71% confidence)");
ok("a line with no confidence omits the parenthetical", outcomeLine(parseVerdict("PASS\nfine")) === "✓ outcome: fine");

// --- the fix-it follow-up -----------------------------------------------------
const fixPrompt = outcomeFixPrompt(fail);
ok("the fix prompt quotes the critique", fixPrompt.includes("missing error handling in fetchUser"));
ok("...and tells the model to scope the change", /Change nothing else/.test(fixPrompt));
ok("...and leaves room to push back", /you believe the check is wrong/.test(fixPrompt));

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

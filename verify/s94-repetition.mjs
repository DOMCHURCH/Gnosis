// Verify (repetition guard): a model that loops gets cut off.
//
// The failure this exists for, observed in a real voice session: the model
// emitted "I'll click the search box." roughly 150 times inside ONE assistant
// message, with no tool calls between them, until the user hit stop. Every limit
// in the engine missed it — the iteration cap counts tool rounds and this was a
// single round, the token budget is a session total and a short repeated line is
// cheap per copy, and compaction only runs between iterations. So the only
// bounds were the model's max_tokens and the user's patience.
//
// Two properties matter and both are pinned here: it TRIPS on degenerate output,
// and it does NOT trip on legitimate output that happens to contain repetition
// (a numbered list, a table, code, short punctuation lines). A guard that fires
// on real work is worse than no guard.
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const imp = (f) => import(pathToFileURL(path.resolve(here, f)).href);

const { RepetitionGuard, collapseRepeats } = await imp("../dist/repetition.js");

let fails = 0;
const ok = (n, c, extra = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${extra ? ` — ${extra}` : ""}`); if (!c) fails++; };

/** Feed lines until the guard trips; returns how many it took, or null. */
function feed(lines, guard = new RepetitionGuard()) {
  for (let i = 0; i < lines.length; i++) if (guard.push(lines[i])) return { at: i + 1, guard };
  return { at: null, guard };
}

// --- 1. the real failure ----------------------------------------------------
{
  const line = "I'll click the search box.";
  const { at, guard } = feed(Array(150).fill(line));
  ok("it trips on the exact observed failure", at !== null, `after ${at} lines`);
  ok("...quickly, not after a hundred", at !== null && at <= 10, `${at} lines`);
  ok("...and says what repeated", /repeated|same line/i.test(guard.result.reason ?? ""));
  ok("...naming the offending line", (guard.result.line ?? "").includes("click the search box"));
  ok("once tripped it stays tripped", guard.push("something completely different") === true);
}

// --- 2. the cyclic shape (A B A B ...) --------------------------------------
// No two adjacent lines are equal here, so a consecutive-only check never fires.
{
  const cycle = [];
  for (let i = 0; i < 60; i++) cycle.push(i % 2 ? "Let me try the Start menu." : "That did not open it.");
  const { at } = feed(cycle);
  ok("it trips on an A/B/A/B cycle", at !== null, `after ${at} lines`);
}
{
  // A three-line cycle, which is what a "click, screenshot, retry" narration loop
  // actually looks like.
  const cycle = [];
  for (let i = 0; i < 60; i++) cycle.push(["Taking a screenshot now.", "That did not work either.", "Let me try clicking it."][i % 3]);
  const { at } = feed(cycle);
  ok("...and on a three-line cycle", at !== null, `after ${at} lines`);
}

// --- 3. it must NOT fire on legitimate output -------------------------------
{
  const cases = [
    ["a numbered list", Array.from({ length: 40 }, (_, i) => `${i + 1}. Step number ${i + 1} of the migration plan`)],
    ["prose that never repeats", Array.from({ length: 40 }, (_, i) => `The quick brown fox jumped over lazy dog number ${i}.`)],
    ["repeated short punctuation", Array.from({ length: 40 }, () => "}")],
    ["blank separators", Array.from({ length: 40 }, () => "")],
    ["a table with a repeated separator", Array.from({ length: 30 }, (_, i) => (i % 2 ? "|---|---|" : `| row ${i} | value ${i} |`))],
    ["five identical lines, under the threshold", Array(5).fill("This line appears five times exactly.")],
  ];
  for (const [name, lines] of cases) {
    const { at } = feed(lines);
    ok(`it does NOT trip on ${name}`, at === null, at ? `tripped at ${at}` : "");
  }
}

// --- 4. history is not poisoned ---------------------------------------------
// Storing the degenerate run verbatim is the strongest possible prior that the
// next line should be the same again — the guard would then fire every turn on a
// conversation it had itself poisoned.
{
  const line = "I'll click the search box.";
  const out = collapseRepeats(Array(150).fill(line).join("\n"));
  const kept = out.split("\n").filter((l) => l === line).length;
  ok("a degenerate run is collapsed before storage", kept === 1, `${kept} copies kept`);
  ok("...and says how many there were", /repeated 150 times/.test(out));
  ok("...so the stored text is small", out.length < 200, `${out.length} chars`);

  // Ordinary text must survive untouched, or this quietly corrupts history.
  const prose = ["First line of a real answer.", "Second line of a real answer.", "Third line here."].join("\n");
  ok("ordinary text is left alone", collapseRepeats(prose) === prose);
  // Two identical lines is not a degenerate run.
  const twice = "This line appears twice here.\nThis line appears twice here.";
  ok("...and so is an ordinary duplicate", collapseRepeats(twice) === twice);
}

// --- 5. it is actually wired into the stream --------------------------------
// A guard that exists but is never fed is the same as no guard.
{
  const eng = readFileSync(path.join(root, "src", "engine.ts"), "utf8");
  ok("the engine constructs a guard per request", /new RepetitionGuard\(\)/.test(eng));
  ok("...feeds it the streamed lines", /repetition\.push\(line\.text\)/.test(eng));
  ok("...and aborts the request when it trips", /repetition\.push\(line\.text\)[\s\S]{0,80}reqAbort\.abort\(\)/.test(eng));

  // The abort must target the REQUEST, not the turn: aborting the turn's own
  // controller would surface to the user as "you cancelled this", which is a lie
  // and also skips the explanation.
  ok("the abort is per-request, not the turn's", /const reqAbort = new AbortController\(\)/.test(eng));
  ok("...and the turn's abort still cancels the request", /addEventListener\("abort", relayAbort/.test(eng));
  ok("...and the listener is removed on both paths",
    (eng.match(/removeEventListener\("abort", relayAbort\)/g) ?? []).length >= 2);

  // Both exits are covered: the abort can land before OR after the final chunk.
  // Asserted by ORDER rather than by proximity — the point is that the guard is
  // checked inside the catch and ahead of the user-abort branch, since to the
  // request the two are indistinguishable and whichever runs first wins.
  {
    const c = eng.indexOf("} catch (e) {", eng.indexOf("const repetition = new RepetitionGuard()"));
    const guardCheck = eng.indexOf("repetition.tripped", c);
    const userAbort = eng.indexOf("if (this.abortController.signal.aborted) {", c);
    ok("it is handled on the throw path", c !== -1 && guardCheck !== -1);
    ok("...ahead of the user-abort branch", guardCheck !== -1 && userAbort !== -1 && guardCheck < userAbort);
  }
  ok("...and on the normal-completion path",
    eng.indexOf("if (repetition.tripped) {", eng.indexOf("// Commit the final partial line") - 500) !== -1);
  // And it must not be reported as a user abort.
  ok("a guard trip is not reported as a user abort",
    /repetition\.tripped && !this\.abortController\.signal\.aborted/.test(eng));
  ok("only a collapsed copy reaches history", /collapseRepeats\(/.test(eng));
}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

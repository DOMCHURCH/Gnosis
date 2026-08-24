// Verify (kanban): sessions classify into the four columns — plan mode is REVIEW
// (authoritative), a client override marks PARKED, everything else is ACTIVE, and
// DONE is never a resting column; the card's task is the last assistant message.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const k = await import(pathToFileURL(path.resolve(here, "../web/src/kanban.js")).href);

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

ok("four columns in order", k.COLUMNS.join(",") === "active,parked,review,done");

// --- columnFor ------------------------------------------------------------------
ok("a plain (ask) session is ACTIVE", k.columnFor({ mode: "ask" }, undefined) === "active");
ok("plan mode is REVIEW regardless of override", k.columnFor({ mode: "plan" }, "parked") === "review");
ok("a parked override moves a non-plan session to PARKED", k.columnFor({ mode: "ask" }, "parked") === "parked");
ok("a review override is ignored unless the mode is plan", k.columnFor({ mode: "ask" }, "review") === "active");
ok("a missing agent defaults to ACTIVE", k.columnFor(undefined, undefined) === "active");

// --- boardColumns ---------------------------------------------------------------
const state = {
  order: [1, 2, 3, 4],
  agents: { 1: { mode: "ask" }, 2: { mode: "plan" }, 3: { mode: "yolo" }, 4: { mode: "ask" } },
  chatLines: [
    { tabId: 1, kind: "assistant", text: "first" },
    { tabId: 1, kind: "assistant", text: "the   latest   answer" },
    { tabId: 1, kind: "user", text: "ignored user line" },
  ],
};
const board = k.boardColumns(state, { 3: "parked" });
ok("plan-mode session lands in REVIEW", board.review.includes(2));
ok("parked-override session lands in PARKED", board.parked.includes(3));
ok("ask/yolo sessions land in ACTIVE", board.active.includes(1) && board.active.includes(4));
ok("no session is auto-placed in DONE", board.done.length === 0);
ok("every session is placed exactly once", board.active.length + board.parked.length + board.review.length + board.done.length === 4);

// --- lastAssistant --------------------------------------------------------------
ok("the card task is the LAST assistant message, whitespace-collapsed", k.lastAssistant(state.chatLines, 1) === "the latest answer");
ok("a user line is never used as the task", k.lastAssistant(state.chatLines, 1) !== "ignored user line");
ok("no assistant output → empty task", k.lastAssistant(state.chatLines, 99) === "");
ok("a long task is truncated with an ellipsis", (() => {
  const long = "x".repeat(200);
  const r = k.lastAssistant([{ tabId: 7, kind: "assistant", text: long }], 7, 40);
  return r.length === 40 && r.endsWith("…");
})());

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

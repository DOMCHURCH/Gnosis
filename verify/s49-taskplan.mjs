// Verify (task execution plan): a task.plan event seeds one row per subtask
// (queued); subagent.start flips a row to running and stamps its start; subagent.end
// flips it to done (or failed when ok:false) and stamps its end; the roll-up reports
// completion; and elapsed ticks from the stamped times.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const p = await import(pathToFileURL(path.resolve(here, "../web/src/taskplan.js")).href);

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const PLAN_EV = {
  type: "task.plan", tabId: 1, planId: "1:0",
  subtasks: [
    { index: 1, description: "auth and permissions" },
    { index: 2, description: "exposed secrets" },
    { index: 3, description: "sql injection" },
  ],
};

let plan = p.planFromEvent(PLAN_EV);
ok("plan seeds one row per subtask", plan.subtasks.length === 3);
ok("every row starts queued", plan.subtasks.every((s) => s.status === "queued" && s.startedAt === null && s.endedAt === null));
ok("rows keep their assigned agent id (index)", plan.subtasks.map((s) => s.index).join(",") === "1,2,3");

let st = p.planStatus(plan);
ok("roll-up: nothing complete yet", st.queued === 3 && !st.complete);

// all three start (Promise.all fires them together)
plan = p.foldPlan(plan, { type: "subagent.start", tabId: 1, description: "auth and permissions" }, 1000);
plan = p.foldPlan(plan, { type: "subagent.start", tabId: 1, description: "exposed secrets" }, 1000);
plan = p.foldPlan(plan, { type: "subagent.start", tabId: 1, description: "sql injection" }, 1000);
ok("subagent.start flips matching rows to running", plan.subtasks.every((s) => s.status === "running" && s.startedAt === 1000));

// one finishes ok, one fails, one still running
plan = p.foldPlan(plan, { type: "subagent.end", tabId: 1, description: "auth and permissions", ok: true }, 4000);
plan = p.foldPlan(plan, { type: "subagent.end", tabId: 1, description: "exposed secrets", ok: false }, 5000);
ok("subagent.end ok:true → done", plan.subtasks[0].status === "done" && plan.subtasks[0].endedAt === 4000);
ok("subagent.end ok:false → failed", plan.subtasks[1].status === "failed");
ok("an unfinished row stays running", plan.subtasks[2].status === "running");

st = p.planStatus(plan);
ok("roll-up counts done + failed + running", st.done === 1 && st.failed === 1 && st.running === 1 && !st.complete);

plan = p.foldPlan(plan, { type: "subagent.end", tabId: 1, description: "sql injection", ok: true }, 6000);
st = p.planStatus(plan);
ok("plan is complete once every row finished", st.complete && st.done === 2 && st.failed === 1);

// a finished row is not reopened by a stray later event
const before = plan.subtasks[0].status;
plan = p.foldPlan(plan, { type: "subagent.start", tabId: 1, description: "auth and permissions" }, 9000);
ok("a done row is not reopened by a late duplicate event", plan.subtasks[0].status === before);

// icons + elapsed
ok("status icons map correctly", p.statusIcon("done") === "✓" && p.statusIcon("failed") === "✗" && p.statusIcon("running") === "◐" && p.statusIcon("queued") === "○");
ok("elapsed uses stamped end when finished", p.subtaskElapsed({ startedAt: 1000, endedAt: 4000 }, 99999) === "3s");
ok("elapsed ticks from now while running", p.subtaskElapsed({ startedAt: 1000, endedAt: null }, 1000 + 65000) === "1m 5s");
ok("elapsed is empty before a row starts", p.subtaskElapsed({ startedAt: null, endedAt: null }, 5000) === "");

// unrelated events / no plan are no-ops
ok("foldPlan on null plan returns null", p.foldPlan(null, { type: "subagent.start", tabId: 1, description: "x" }, 0) === null);

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

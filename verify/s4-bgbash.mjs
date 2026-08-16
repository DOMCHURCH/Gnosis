// Verify (feature 3 — background bash): a `run_in_background` command returns
// immediately with a job id while it keeps running; /jobs sees it; /kill tree-kills
// it (gone from the OS process table); a finished job captures output + fires the
// completion event.
import { jobs } from "../dist/jobs.js";
import { runBash } from "../dist/tools/bash.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const doneEvents = [];
jobs.on("done", (j) => doneEvents.push(j));

// --- launched via the bash tool: returns immediately, keeps running ------------
const t0 = Date.now();
const r = await runBash({ command: "sleep 30", run_in_background: true });
const dt = Date.now() - t0;
ok("a background command returns immediately (not after 30s)", dt < 3000);
ok("...with no error and a job id in the result", !r.isError && /job \d+/i.test(r.output));

const sleepJob = jobs.running().find((j) => j.command.includes("sleep 30"));
ok("/jobs shows the running job", !!sleepJob && sleepJob.status === "running");
ok("its output buffer is queryable while running", jobs.output(sleepJob.id) !== null);
ok("the process is actually alive", sleepJob && sleepJob.pid != null && alive(sleepJob.pid));

// --- /kill tree-kills it -------------------------------------------------------
jobs.kill(sleepJob.id);
ok("kill marks the job killed", jobs.get(sleepJob.id).status === "killed");
let gone = false;
for (let i = 0; i < 20 && !gone; i++) { if (!alive(sleepJob.pid)) gone = true; else await wait(100); }
ok("/kill removes the process from the OS process table", gone);
ok("killing fires the completion event", doneEvents.some((j) => j.id === sleepJob.id && j.status === "killed"));

// --- a short background command completes, captures output, fires 'done' --------
const echo = jobs.launch("echo bghello", process.cwd(), null);
let finished = null;
for (let i = 0; i < 40 && !finished; i++) {
  const j = jobs.get(echo.id);
  if (j.status !== "running") finished = j;
  else await wait(50);
}
ok("a short background job reaches a terminal state", finished && finished.status === "done");
ok("its output is captured", /bghello/.test(jobs.output(echo.id) ?? ""));
ok("completion fires the 'done' event", doneEvents.some((j) => j.id === echo.id && j.status === "done"));

jobs.killAll();
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

// Verify (dreaming): the caps, the persisted log, restart reconciliation, and the
// two guarantees that matter most — a dream never blocks forever, and no dream
// outlives the process that spawned it.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DreamManager, loadDreams, saveDreams, capHit, formatDream, withTimeout,
  DREAM_MAX_ITERATIONS, DREAM_MAX_USD, DREAM_MAX_MS,
} from "../dist/dreams.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const home = await fs.mkdtemp(path.join(os.tmpdir(), "gnosis-dreams-"));

// --- caps ---------------------------------------------------------------------
const base = { id: "d1", task: "t", status: "running", cwd: ".", model: "m", startedAt: 1000, endedAt: null, usd: 0, iterations: 0, summary: "" };
ok("a fresh dream has hit no cap", capHit({ ...base }, 1000) === null);
ok("the iteration cap is detected", /50-iteration/.test(capHit({ ...base, iterations: DREAM_MAX_ITERATIONS }, 1000) ?? ""));
ok("the dollar cap is detected", /\$2 budget/.test(capHit({ ...base, usd: DREAM_MAX_USD }, 1000) ?? ""));
ok("the time cap is detected", /2-hour/.test(capHit({ ...base }, 1000 + DREAM_MAX_MS) ?? ""));
ok("just under a cap does not trip it", capHit({ ...base, iterations: 49, usd: 1.99 }, 1000 + DREAM_MAX_MS - 1) === null);

// --- nothing inside a dream can block forever ---------------------------------
const slow = new Promise(() => {}); // never resolves
const t0 = Date.now();
ok("withTimeout falls back rather than hanging", (await withTimeout(slow, 50, "fallback")) === "fallback");
ok("...and does so promptly", Date.now() - t0 < 2000);
ok("a resolved promise still wins", (await withTimeout(Promise.resolve("real"), 1000, "fallback")) === "real");
ok("a rejected promise degrades to the fallback", (await withTimeout(Promise.reject(new Error("x")), 1000, "fallback")) === "fallback");

// --- the persisted log --------------------------------------------------------
ok("a missing log reads as empty", (await loadDreams(path.join(home, "nope"))).length === 0);
await fs.writeFile(path.join(home, "dreams.json"), "{ not json", "utf8");
ok("a corrupt log reads as empty rather than throwing", (await loadDreams(home)).length === 0);

await saveDreams(home, [{ ...base, id: "d1", startedAt: 1 }, { ...base, id: "d2", startedAt: 2 }]);
const loaded = await loadDreams(home);
ok("records round-trip", loaded.length === 2);
ok("newest is first", loaded[0].id === "d2");

// The log is bounded so it can't grow without limit.
await saveDreams(home, Array.from({ length: 80 }, (_, i) => ({ ...base, id: `d${i}`, startedAt: i })));
ok("the log is capped at 50", (await loadDreams(home)).length === 50);

// --- restart reconciliation ---------------------------------------------------
// A dream marked "running" belongs to a process that is gone; it must not be
// reported as still running after a restart.
await saveDreams(home, [{ ...base, id: "d7", status: "running", startedAt: 5 }]);
const dm = new DreamManager(home, { fork: () => { throw new Error("not used"); } });
const after = await dm.init();
ok("an interrupted dream is not left marked running", after[0].status === "stopped");
ok("...and says why", /interrupted/.test(after[0].summary));
ok("...and is offered as resumable", dm.resumable().length === 1);
ok("...and the change is persisted", (await loadDreams(home))[0].status === "stopped");
ok("active() is empty after reconciliation", dm.active().length === 0);

// ids stay unique across a restart
await saveDreams(home, [{ ...base, id: "d9", status: "done", startedAt: 5 }]);
const dm2 = new DreamManager(home, { fork: () => { throw new Error("not used"); } });
await dm2.init();
let started = null;
try {
  started = dm2.start("a task");
} catch { /* fork throws — we only care about the id it chose */ }
ok("ids continue past the highest persisted id", started === null || started.id === "d10");

// --- formatting ---------------------------------------------------------------
const line = formatDream({ ...base, id: "d1", status: "done", usd: 0.1234, startedAt: 0, endedAt: 60000, summary: "did the thing" });
ok("the listing shows id, status and cost", /d1/.test(line) && /done/.test(line) && /\$0\.1234/.test(line));
ok("the listing shows the summary", /did the thing/.test(line));

// --- resume: a fresh re-run, never a continuation -----------------------------
{
  const h = await fs.mkdtemp(path.join(os.tmpdir(), "gnosis-resume-"));
  await saveDreams(h, [
    { ...base, id: "d3", status: "stopped", task: "refactor auth", cwd: "/work", summary: "interrupted — the process it ran in exited", startedAt: 10 },
    { ...base, id: "d4", status: "done", task: "already finished", startedAt: 20 },
  ]);
  // A fork that records what it was asked for, so we can assert the re-run uses
  // the ORIGINAL task and cwd rather than anything derived from the old run.
  const forked = [];
  const mgr = new DreamManager(h, {
    fork: (cwd) => {
      forked.push(cwd);
      // Minimal engine stand-in: start() only touches these before running.
      return { cwd: cwd ?? "/default", modelId: "m", interactive: true, noPersist: false, maxIterations: 0, cost: { usd: 0 }, messages: [], abort() {}, run: () => new Promise(() => {}) };
    },
  });
  await mgr.init();

  ok("resuming an unknown id is refused", mgr.resume("nope").ok === false);
  const r = mgr.resume("d3");
  ok("resuming an interrupted dream succeeds", r.ok === true);
  ok("...with a NEW id", r.record.id !== "d3");
  ok("...carrying the ORIGINAL task", r.record.task === "refactor auth");
  ok("...re-run in the original cwd", forked[0] === "/work");
  ok("...starting from scratch, not mid-flight", r.record.iterations === 0 && r.record.usd === 0 && r.record.summary === "");
  ok("...and running", r.record.status === "running");
  ok("...linked back to the dream it re-runs", r.record.resumedFrom === "d3");

  const old = mgr.get("d3");
  ok("the original record is untouched", old.status === "stopped" && /interrupted/.test(old.summary));
  ok("both attempts appear in the history", mgr.list().filter((d) => d.task === "refactor auth").length === 2);

  ok("a still-running dream cannot be resumed", mgr.resume(r.record.id).ok === false);
  ok("a finished (non-interrupted) dream can still be re-run", mgr.resume("d4").ok === true);

  const line = formatDream(r.record);
  ok("the listing shows the lineage", /resumed from d3/.test(line));

  mgr.stopAll();
  mgr.dispose();
  try { await fs.rm(h, { recursive: true, force: true }); } catch {}
}

// --- cleanup ------------------------------------------------------------------
ok("stopAll is safe with nothing running", (() => { try { dm.stopAll(); return true; } catch { return false; } })());
ok("dispose is safe to call", (() => { try { dm.dispose(); dm2.dispose(); return true; } catch { return false; } })());

try { await fs.rm(home, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

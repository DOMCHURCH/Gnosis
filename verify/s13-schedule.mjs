// Verify (3.5 — scheduled runs): spec parsing, due-calculation, the on-disk
// registry (add/remove/persist), and tick() firing only the due schedules with a
// mock runner + recording each outcome. Real wall-clock/cron firing is exercised
// only by `dom schedule tick|daemon` and is NOT auto-verified.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const S = await import("../dist/schedule.js");
const { tick } = await import("../dist/scheduler.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };
const HOUR = 3_600_000, MIN = 60_000;

// --- parseSpec ---------------------------------------------------------------
ok("parse 'every 30m'", (() => { const p = S.parseSpec("every 30m"); return p.kind === "every" && p.ms === 30 * MIN; })());
ok("parse 'every 2 hours'", (() => { const p = S.parseSpec("every 2 hours"); return p.kind === "every" && p.ms === 2 * HOUR; })());
ok("parse 'hourly'", (() => { const p = S.parseSpec("hourly"); return p.kind === "every" && p.ms === HOUR; })());
ok("parse 'daily 14:30'", (() => { const p = S.parseSpec("daily 14:30"); return p.kind === "daily" && p.hour === 14 && p.minute === 30; })());
ok("parse 'daily at 9:05'", (() => { const p = S.parseSpec("daily at 9:05"); return p.kind === "daily" && p.hour === 9 && p.minute === 5; })());
ok("reject 'every 0m'", S.parseSpec("every 0m").kind === "error");
ok("reject unknown unit 'every 5x'", S.parseSpec("every 5x").kind === "error");
ok("reject 'daily 25:00'", S.parseSpec("daily 25:00").kind === "error");
ok("reject gibberish", S.parseSpec("whenever").kind === "error");

// --- isDue: interval ---------------------------------------------------------
const T0 = new Date(2026, 0, 15, 12, 0, 0).getTime();
const every1h = { id: "a", spec: "every 1h", prompt: "p", cwd: fake, enabled: true, createdAt: T0 };
ok("interval not due before the period elapses", S.isDue(every1h, T0 + 30 * MIN) === false);
ok("interval due after the period elapses", S.isDue(every1h, T0 + 61 * MIN) === true);
ok("interval uses lastRunAt as the base", S.isDue({ ...every1h, lastRunAt: T0 + 61 * MIN }, T0 + 61 * MIN) === false);
ok("interval due one period after lastRunAt", S.isDue({ ...every1h, lastRunAt: T0 + 61 * MIN }, T0 + 61 * MIN + HOUR) === true);
ok("a disabled schedule is never due", S.isDue({ ...every1h, enabled: false }, T0 + 10 * HOUR) === false);

// --- isDue: daily ------------------------------------------------------------
const daily9 = { id: "b", spec: "daily 09:00", prompt: "p", cwd: fake, enabled: true, createdAt: new Date(2026, 0, 15, 0, 0, 0).getTime() };
const day1_10 = new Date(2026, 0, 15, 10, 0, 0).getTime();
ok("daily due after its slot passes today", S.isDue(daily9, day1_10) === true);
ok("daily not due again after running past the slot", S.isDue({ ...daily9, lastRunAt: day1_10 }, new Date(2026, 0, 15, 11, 0, 0).getTime()) === false);
ok("daily due again the next day", S.isDue({ ...daily9, lastRunAt: day1_10 }, new Date(2026, 0, 16, 10, 0, 0).getTime()) === true);

// --- nextRunAt ---------------------------------------------------------------
ok("nextRunAt skips missed intervals to the next future one",
  S.nextRunAt({ ...every1h, lastRunAt: T0 }, T0 + 90 * MIN) === T0 + 2 * HOUR);

// --- registry CRUD -----------------------------------------------------------
const add1 = await S.addSchedule({ spec: "every 15m", prompt: "check build", cwd: fake }, Date.now(), "r1");
ok("addSchedule persists a valid schedule", add1.ok === true && (await S.loadSchedules()).length === 1);
const addBad = await S.addSchedule({ spec: "nonsense", prompt: "x", cwd: fake }, Date.now(), "r2");
ok("addSchedule rejects an invalid spec", addBad.ok === false);
ok("addSchedule rejects an empty prompt", (await S.addSchedule({ spec: "hourly", prompt: "  ", cwd: fake }, Date.now(), "r3")).ok === false);
ok("removeSchedule removes by id", (await S.removeSchedule(add1.schedule.id)) === true && (await S.loadSchedules()).length === 0);
ok("removeSchedule on a bad id returns false", (await S.removeSchedule("nope")) === false);

// --- tick fires only due schedules and records outcomes ----------------------
await S.saveSchedules([]);
const now = Date.now();
const dueOne = { id: "due1", spec: "every 1s", prompt: "run me", cwd: fake, enabled: true, createdAt: now - 10_000 };
const notYet = { id: "later", spec: "every 1d", prompt: "not yet", cwd: fake, enabled: true, createdAt: now };
await S.saveSchedules([dueOne, notYet]);

const ran = [];
const outcomes = await tick(now, async (s) => { ran.push(s.id); return true; });
ok("tick runs exactly the due schedule", ran.length === 1 && ran[0] === "due1");
ok("tick reports the outcome", outcomes.length === 1 && outcomes[0].id === "due1" && outcomes[0].status === "ok");
const after = await S.loadSchedules();
ok("tick records lastRunAt/lastStatus for the fired schedule", after.find((s) => s.id === "due1").lastRunAt === now && after.find((s) => s.id === "due1").lastStatus === "ok");
ok("tick leaves the not-yet-due schedule untouched", after.find((s) => s.id === "later").lastRunAt === undefined);

// error outcome path
await S.saveSchedules([{ ...dueOne, lastRunAt: undefined }]);
const errOut = await tick(now, async () => false);
ok("a failing run is recorded as an error", errOut[0].status === "error" && (await S.loadSchedules())[0].lastStatus === "error");

try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

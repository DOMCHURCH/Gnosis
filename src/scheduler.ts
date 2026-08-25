// Scheduler: the `dom schedule ...` CLI, plus the headless firing of a due run.
// The pure registry/due logic lives in schedule.ts; this file adds the parts that
// touch the world — booting an engine to run a due prompt, and the tick/daemon
// loop a real cron entry (or `dom schedule daemon`) drives.

import { boot, parseArgs } from "./startup.js";
import { runPipe } from "./pipe.js";
import {
  addSchedule,
  dueSchedules,
  loadSchedules,
  nextRunAt,
  recordRun,
  removeSchedule,
  type Schedule,
} from "./schedule.js";

export interface TickOutcome {
  id: string;
  prompt: string;
  status: "ok" | "error";
}

function randSuffix(): string {
  return Math.floor(Math.random() * 1e6).toString(36);
}

/** Run one schedule headlessly: boot in its cwd, run its prompt in pipe mode, and
 * persist it as a session so the user can /resume and read the result. Returns
 * true on a clean run. Never throws. */
export async function runScheduledPrompt(schedule: Schedule): Promise<boolean> {
  try {
    const flags = parseArgs([]);
    flags.print = true;
    flags.save = true; // keep the run as a resumable session
    if (schedule.model) flags.model = schedule.model;
    const { engine } = await boot(flags, schedule.cwd);
    const code = await runPipe(engine, { prompt: schedule.prompt, save: true });
    return code === 0;
  } catch {
    return false;
  }
}

/** Fire every schedule due at `now`, recording each outcome. `run` is injectable
 * for testing; it defaults to the real headless runner. */
export async function tick(
  now: number,
  run: (s: Schedule) => Promise<boolean> = runScheduledPrompt,
): Promise<TickOutcome[]> {
  const due = dueSchedules(await loadSchedules(), now);
  const outcomes: TickOutcome[] = [];
  for (const s of due) {
    const ok = await run(s);
    await recordRun(s.id, now, ok ? "ok" : "error");
    outcomes.push({ id: s.id, prompt: s.prompt, status: ok ? "ok" : "error" });
  }
  return outcomes;
}

function fmtWhen(ts?: number): string {
  if (!ts) return "never";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

/** The `dom schedule <sub> ...` CLI. Returns the process exit code. */
export async function runScheduleCommand(args: string[]): Promise<number> {
  const sub = (args[0] ?? "list").toLowerCase();

  switch (sub) {
    case "add": {
      const spec = args[1];
      const prompt = args.slice(2).join(" ");
      if (!spec || !prompt) {
        process.stderr.write('usage: gnosis schedule add "<spec>" "<prompt>"   (spec: "every 30m", "hourly", "daily 14:30")\n');
        return 1;
      }
      const r = await addSchedule({ spec, prompt, cwd: process.cwd() }, Date.now(), randSuffix());
      if (!r.ok) {
        process.stderr.write(`${r.error}\n`);
        return 1;
      }
      const nxt = nextRunAt(r.schedule, Date.now());
      process.stdout.write(`added ${r.schedule.id}: ${r.schedule.spec} — ${r.schedule.prompt}\n`);
      process.stdout.write(`next run: ${fmtWhen(nxt ?? undefined)}   (fires when \`dom schedule tick\` runs after that time)\n`);
      return 0;
    }

    case "list": {
      const all = await loadSchedules();
      if (!all.length) {
        process.stdout.write('no scheduled runs. add one: dom schedule add "every 1h" "check the build and summarize failures"\n');
        return 0;
      }
      const now = Date.now();
      for (const s of all) {
        const nxt = nextRunAt(s, now);
        process.stdout.write(
          `${s.id}  [${s.enabled ? "on" : "off"}]  ${s.spec}\n` +
            `    prompt: ${s.prompt}\n` +
            `    cwd: ${s.cwd}${s.model ? `   model: ${s.model}` : ""}\n` +
            `    last: ${fmtWhen(s.lastRunAt)}${s.lastStatus ? ` (${s.lastStatus})` : ""}   next: ${fmtWhen(nxt ?? undefined)}\n`,
        );
      }
      return 0;
    }

    case "remove":
    case "rm": {
      const id = args[1];
      if (!id) {
        process.stderr.write("usage: gnosis schedule remove <id>\n");
        return 1;
      }
      const ok = await removeSchedule(id);
      process.stdout.write(ok ? `removed ${id}\n` : `no schedule with id ${id}\n`);
      return ok ? 0 : 1;
    }

    case "run": {
      // Force-run one schedule now, regardless of whether it's due.
      const id = args[1];
      if (!id) {
        process.stderr.write("usage: gnosis schedule run <id>\n");
        return 1;
      }
      const s = (await loadSchedules()).find((x) => x.id === id);
      if (!s) {
        process.stderr.write(`no schedule with id ${id}\n`);
        return 1;
      }
      const ok = await runScheduledPrompt(s);
      await recordRun(s.id, Date.now(), ok ? "ok" : "error");
      process.stdout.write(`${ok ? "✓" : "✗"} ${s.id}\n`);
      return ok ? 0 : 1;
    }

    case "tick": {
      // What a cron entry / Task Scheduler action calls (e.g. every minute).
      const outcomes = await tick(Date.now());
      if (!outcomes.length) {
        process.stdout.write("no schedules due.\n");
        return 0;
      }
      for (const o of outcomes) process.stdout.write(`${o.status === "ok" ? "✓" : "✗"} ${o.id}: ${o.prompt}\n`);
      return outcomes.some((o) => o.status === "error") ? 1 : 0;
    }

    case "daemon": {
      // Long-running: tick once a minute. Real scheduled firing over wall-clock
      // time is only exercised here (not auto-verified).
      process.stderr.write("gnosis scheduler running — ticking every 60s. Ctrl+C to stop.\n");
      for (;;) {
        const outcomes = await tick(Date.now());
        for (const o of outcomes) process.stderr.write(`${o.status === "ok" ? "✓" : "✗"} ${o.id}: ${o.prompt}\n`);
        await new Promise((r) => setTimeout(r, 60_000));
      }
    }

    default:
      process.stderr.write(
        "usage: gnosis schedule <add|list|remove|run|tick|daemon>\n" +
          '  add "<spec>" "<prompt>"   spec: "every 30m" | "hourly" | "daily 14:30"\n' +
          "  list                      show schedules with next-run times\n" +
          "  remove <id>               delete a schedule\n" +
          "  run <id>                  run one now, regardless of schedule\n" +
          "  tick                      run everything due now (wire to cron/Task Scheduler)\n" +
          "  daemon                    stay running and tick every 60s\n",
      );
      return 1;
  }
}

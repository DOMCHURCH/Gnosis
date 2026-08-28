import type { OfficeArgs } from "./schemas.js";
import type { ToolContext, ToolResult } from "./index.js";

/**
 * Desks per zone on the web office floor. The browser owns the real layout
 * (web/src/sessions.js ZONES) — this copy exists so the tool can tell the model
 * how many desks it is asking for without a round trip. verify/s71-office.mjs
 * asserts the two stay in step, so a slot added there fails loudly here.
 */
export const ZONE_DESKS: Record<string, number> = {
  coordinator: 1,
  planning: 2,
  application: 2,
  coding: 8,
  subagents: 6,
};

/** Name pool for auto-generated agents — one flavour per zone, so a filled floor
 * reads like a staffed office rather than agent-1..19. */
const NAME_POOL: Record<string, string[]> = {
  coordinator: ["orchestrator", "dispatcher"],
  planning: ["planner", "scoper", "estimator"],
  application: ["app-runner", "previewer", "smoke-test"],
  coding: ["refactor", "typefix", "test-writer", "migrator", "linter", "docgen", "patcher", "bugfix"],
  subagents: ["scout", "grepper", "reader", "summarizer", "tracer", "auditor"],
};

/**
 * Zone order on the floor. The browser seats a whole-office fill zone by zone in
 * this order (web/src/sessions.js ZONES), so generating names in it keeps each
 * desk's nameplate matching the room it lands in.
 */
export const ZONE_ORDER = ["coordinator", "planning", "application", "coding", "subagents"] as const;

/** Auto names for one zone, continuing past the pool as <zone>-N. */
export function generatedNames(zone: string, count: number): string[] {
  const pool = NAME_POOL[zone] ?? [];
  return Array.from({ length: count }, (_, i) => pool[i] ?? `${zone}-${i + 1}`);
}

/** Auto names for a request: one zone's flavour, or every zone in floor order. */
export function autoNames(zone: string | null, count: number): string[] {
  if (zone) return generatedNames(zone, count);
  const all: string[] = [];
  for (const z of ZONE_ORDER) all.push(...generatedNames(z, ZONE_DESKS[z]!));
  // Past a full house (desks freed up and asked for again), keep going generically.
  while (all.length < count) all.push(`agent-${all.length + 1}`);
  return all.slice(0, count);
}

/**
 * The zone each seat belongs to, in floor order — the zone-labelled twin of
 * autoNames, so a whole-office fill can tell each real session which room it
 * landed in.
 */
export function autoZones(zone: string | null, count: number): string[] {
  if (zone) return Array.from({ length: count }, () => zone);
  const all: string[] = [];
  for (const z of ZONE_ORDER) for (let i = 0; i < ZONE_DESKS[z]!; i++) all.push(z);
  while (all.length < count) all.push(ZONE_ORDER[ZONE_ORDER.length - 1]!);
  return all.slice(0, count);
}

/** The question the user has to answer before anything is placed. Kept here so
 * the tool, the prompt and verify all quote the same words. */
export const MODE_QUESTION = [
  "Do you want these agents to:",
  "1. Work on real tasks (opens actual sessions with /new)",
  "2. Just fill the floor visually (decoration only)",
].join("\n");

/**
 * Staff the browser's office floor — with real sessions or with decoration, and
 * never without asking which.
 *
 * `mode` carries the user's answer and there is no default: called without it the
 * tool places nothing and hands back MODE_QUESTION for the model to put to the
 * user. That gate is here rather than only in the system prompt because "fill the
 * office" is exactly the request a model will otherwise satisfy silently.
 *
 * mode=decorative is the original behaviour: a placement request onto the event
 * bus (the same channel `window.gnosisOffice` drives from the browser console),
 * which the browser resolves against the desks it actually has free. Those figures
 * have no Engine, no history and no cost — they cannot answer a permission prompt
 * or do a minute of work.
 *
 * mode=real opens a real tab per agent (what `/new` makes) and sends each one its
 * task as a first message. Those seat themselves on the floor as the live agents
 * they are, so it never touches floor.place.
 *
 * Nothing on disk changes either way, so it runs without a permission prompt.
 */
export async function runOffice(args: OfficeArgs, _signal?: AbortSignal, ctx?: ToolContext): Promise<ToolResult> {
  const floor = ctx?.office;
  // Real sessions are tabs, not drawings, so they do not need a browser attached.
  // Everything else does.
  if (!floor && (args.action === "clear" || args.mode !== "real")) {
    return {
      output:
        "office: no browser floor attached. The office floor is the `dom serve` web UI — start it (or tell the " +
        "user to open it) and call this again.",
      isError: true,
    };
  }

  if (args.action === "clear") {
    floor!.clear();
    return { output: "office: cleared every manually-placed agent from the floor", isError: false };
  }

  // The gate: no mode means the user has not been asked yet, and nothing gets
  // placed on an unasked request.
  if (!args.mode) {
    return {
      output: [
        "office: nothing placed — the user has to choose first. Put this to them, in these words:",
        "",
        MODE_QUESTION,
        "",
        'If they pick 1: ask what each zone should work on, then call office again with mode="real" and one entry',
        "in `tasks` per agent. Each becomes a real session with its own engine, started on that task.",
        'If they pick 2: call office again with mode="decorative". Figures only, no sessions.',
      ].join("\n"),
      isError: false,
    };
  }

  const zone = args.zone ?? null;
  if (zone && !ZONE_DESKS[zone]) {
    return { output: `office: unknown zone "${zone}". Zones: ${Object.keys(ZONE_DESKS).join(", ")}.`, isError: true };
  }

  // fill → count null (the browser fills to capacity); add → an explicit count.
  const count = args.action === "fill" ? null : Math.max(1, args.count ?? 1);
  const state = args.state ?? "mixed";
  // Auto-fill the tail of `names` so every desk gets a name even when the model
  // passed fewer than it asked for (or none at all). Generated names skip anything
  // the model already used, so two desks never end up with the same nameplate.
  const asked = count ?? (zone ? ZONE_DESKS[zone]! : Object.values(ZONE_DESKS).reduce((a, b) => a + b, 0));
  const given = (args.names ?? []).map((n) => n.trim()).filter(Boolean);
  const pool = autoNames(zone, asked + given.length).filter((n) => !given.includes(n));
  const names = [...given, ...pool].slice(0, asked);

  const where = zone ? `the ${zone} zone` : "every zone";
  const capacity = zone ? ` (${ZONE_DESKS[zone]} desk${ZONE_DESKS[zone] === 1 ? "" : "s"})` : " (19 desks)";

  if (args.mode === "real") {
    const runtime = ctx?.tab;
    if (!runtime?.createTab) {
      return {
        output:
          "office: real agents are sessions, and sessions only exist in dom's multi-tab runtime (the TUI or " +
          "`dom serve`). There is none here, so nothing was opened. Tell the user, and ask whether decorative " +
          "figures would do instead.",
        isError: true,
      };
    }
    const tasks = (args.tasks ?? []).map((t) => t.trim()).filter(Boolean);
    if (!tasks.length) {
      return {
        output:
          "office: mode=real needs a task per agent — a real session with nothing to do is worse than a drawing. " +
          "Ask the user what each zone should work on, then call again with `tasks`.",
        isError: true,
      };
    }
    const zones = autoZones(zone, asked);
    const wanted = Math.min(asked, tasks.length);
    const opened: string[] = [];
    const failed: string[] = [];
    for (let i = 0; i < wanted; i++) {
      const task = tasks[i]!;
      const r = runtime.createTab(names[i], task.length > 60 ? `${task.slice(0, 57)}...` : task, task);
      if (r.ok) opened.push(`  ${r.name} (${zones[i]}) — ${task}`);
      else failed.push(`  ${names[i]}: ${r.message}`);
    }
    const short = tasks.length < asked
      ? `\nOnly ${tasks.length} task${tasks.length === 1 ? " was" : "s were"} given for ${asked} desk${asked === 1 ? "" : "s"}, so the rest were not opened — ask the user for the missing ones.`
      : "";
    return {
      output:
        `office: opened ${opened.length} real session${opened.length === 1 ? "" : "s"} in ${where}${capacity}:\n` +
        `${opened.join("\n")}\n` +
        "Each is a live tab with its own engine and history, already working on its task, and it seats itself on " +
        "the floor. Use list_tabs to check on them and send_message to steer one." +
        (failed.length ? `\nNot opened:\n${failed.join("\n")}` : "") +
        short,
      isError: false,
    };
  }

  floor!.place(zone, count, names, state);

  const how = count == null ? `filling ${where}${capacity} to capacity` : `${count} agent${count === 1 ? "" : "s"} in ${where}${capacity}`;
  return {
    output:
      `office: placed ${how}, state ${state}. These are visual only — no session behind them, so they cannot do ` +
      "real work, answer a permission prompt, or be messaged. Say that to the user in your reply. Any that don't " +
      "fit a free desk are dropped by the floor.",
    isError: false,
  };
}

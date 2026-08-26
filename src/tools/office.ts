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
 * Place decorative agents on the browser's office floor.
 *
 * These figures have no Engine, no history and no cost — they are the office
 * being staffed, not work being started. The tool emits a placement request onto
 * the event bus (the same channel `window.gnosisOffice` drives from the browser
 * console) and the browser resolves it against the desks it actually has free, so
 * the model never has to know which seats are taken.
 *
 * Nothing on disk changes, so it runs without a permission prompt. With no bus
 * attached (headless, or the TUI with no `dom serve` running) it says so instead
 * of pretending it placed anything.
 */
export async function runOffice(args: OfficeArgs, _signal?: AbortSignal, ctx?: ToolContext): Promise<ToolResult> {
  const floor = ctx?.office;
  if (!floor) {
    return {
      output:
        "office: no browser floor attached. The office floor is the `dom serve` web UI — start it (or tell the " +
        "user to open it) and call this again.",
      isError: true,
    };
  }

  if (args.action === "clear") {
    floor.clear();
    return { output: "office: cleared every manually-placed agent from the floor", isError: false };
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

  floor.place(zone, count, names, state);

  const where = zone ? `the ${zone} zone` : "every zone";
  const capacity = zone ? ` (${ZONE_DESKS[zone]} desk${ZONE_DESKS[zone] === 1 ? "" : "s"})` : " (19 desks)";
  const how = count == null ? `filling ${where}${capacity} to capacity` : `${count} agent${count === 1 ? "" : "s"} in ${where}${capacity}`;
  return {
    output:
      `office: placed ${how}, state ${state}. They are on the floor now — decoration only, no session behind them. ` +
      "Any that don't fit a free desk are dropped by the floor.",
    isError: false,
  };
}

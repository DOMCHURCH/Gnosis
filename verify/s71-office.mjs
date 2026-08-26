// Verify (chat-driven agent placement + the UI's z-index scale).
//
// Two things the browser can't be trusted to keep straight on its own:
//
//   1. "add 5 agents to the coding floor" has to PLACE agents, not explain how to.
//      That path is office tool → bus event → store queue → free-desk planner, and
//      every link of it is pure except the emit, so all of it is checked here
//      against the SAME modules the server and the bundle load.
//   2. The layer scale in web/src/layers.ts is the one place that decides what
//      covers what, so its ordering is asserted rather than assumed.
//
// React glue and real rendering need a browser and are NOT covered here — the
// layout itself is checked live by scripts/check-overlaps.mjs.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const imp = (f) => import(pathToFileURL(path.resolve(here, f)).href);

const { ZONES, ZONE_BY_ID, layoutFloor, planOfficePlacement, PLACEMENT_STATES, pushOfficeRequest, OFFICE_QUEUE_MAX } =
  await imp("../web/src/sessions.js");
// The built tool, so this checks what actually ships (needs `npm run build`).
const { runOffice, ZONE_DESKS, ZONE_ORDER, generatedNames, autoNames } = await imp("../dist/tools/office.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

const fig = (id, zone, state = "thinking") => ({ id, tabId: 1, kind: "tab", name: id, zone, state, action: "", output: [], thinking: [] });

// --- 1. the tool: what the model calls ---------------------------------------
{
  const calls = [];
  const ctx = { office: { place: (zone, count, names, state) => calls.push({ zone, count, names, state }), clear: () => calls.push({ clear: true }) } };

  const r = await runOffice({ action: "add", zone: "coding", count: 5 }, undefined, ctx);
  ok("office(add) emits one placement", calls.length === 1 && !r.isError);
  ok("it passes the zone and the count through", calls[0].zone === "coding" && calls[0].count === 5);
  ok("it generates a name per requested desk", calls[0].names.length === 5 && calls[0].names.every((n) => typeof n === "string" && n.length));
  ok("names default to mixed states", calls[0].state === "mixed");
  ok("the result says what landed on the floor", /placed 5 agents in the coding zone/.test(r.output));

  calls.length = 0;
  await runOffice({ action: "fill" }, undefined, ctx);
  ok("office(fill) with no zone fills every zone", calls[0].zone === null && calls[0].count === null);

  calls.length = 0;
  await runOffice({ action: "add", zone: "planning", count: 2, names: ["scoper"], state: "thinking" }, undefined, ctx);
  ok("model-supplied names are kept, the tail auto-filled without repeating one",
    calls[0].names[0] === "scoper" && calls[0].names.length === 2 && new Set(calls[0].names).size === 2);
  ok("an explicit state is passed through", calls[0].state === "thinking");

  calls.length = 0;
  await runOffice({ action: "clear" }, undefined, ctx);
  ok("office(clear) empties the floor", calls.length === 1 && calls[0].clear === true);

  const noFloor = await runOffice({ action: "fill" }, undefined, {});
  ok("with no browser attached it errors instead of pretending", noFloor.isError && /dom serve/.test(noFloor.output));
}

// --- 2. the desk counts the tool quotes must match the floor's ---------------
{
  ok("the tool's zone list matches the floor's", Object.keys(ZONE_DESKS).sort().join() === ZONES.map((z) => z.id).sort().join());
  ok("every zone's desk count matches the floor's slots", ZONES.every((z) => ZONE_DESKS[z.id] === z.slots.length));
  ok("auto names are unique within a zone", new Set(generatedNames("coding", 8)).size === 8);
  ok("the tool's zone ORDER matches the floor's seating order", ZONE_ORDER.join() === ZONES.map((z) => z.id).join());
  // A whole-office fill names desks zone by zone, so each nameplate matches the
  // room it lands in rather than every desk getting the coding flavour.
  const whole = autoNames(null, 19);
  ok("a whole-office fill names every desk", whole.length === 19 && new Set(whole).size === 19);
  ok("...starting with the coordinator's own name", whole[0] === generatedNames("coordinator", 1)[0]);
  ok("...and the coding desks keep the coding flavour", whole[5] === generatedNames("coding", 1)[0]);
}

// --- 3. the planner: a request meets the desks that are actually free --------
{
  const req = (over) => ({ zone: null, count: null, names: [], state: "mixed", ...over });

  const five = planOfficePlacement(req({ zone: "coding", count: 5 }), [], [], 1);
  ok("5 in coding takes the first 5 coding desks", five.length === 5 && five.every((m) => m.zone === "coding") && five.map((m) => m.slot).join() === "0,1,2,3,4");
  ok("every placed agent gets a unique id", new Set(five.map((m) => m.id)).size === 5);
  ok('"mixed" rotates through the states', five.map((m) => m.state).join() === PLACEMENT_STATES.concat(PLACEMENT_STATES).slice(0, 5).join());

  const named = planOfficePlacement(req({ zone: "coding", count: 2, names: ["alpha", "beta"] }), [], [], 2);
  ok("names are used in placement order", named.map((m) => m.name).join() === "alpha,beta");
  const unnamed = planOfficePlacement(req({ zone: "planning", count: 2 }), [], [], 3);
  ok("a desk past the names still gets one", unnamed.every((m) => m.name.length > 0));

  const fixed = planOfficePlacement(req({ zone: "coding", count: 3, state: "awaiting" }), [], [], 4);
  ok("an explicit state applies to all of them", fixed.every((m) => m.state === "awaiting"));

  const all = planOfficePlacement(req({}), [], [], 5);
  ok("fill with no zone fills the whole office", all.length === ZONES.reduce((a, z) => a + z.slots.length, 0));
  ok("and covers all five zones", new Set(all.map((m) => m.zone)).size === ZONES.length);

  // A real agent already sits at coding slot 0; nothing may be placed on top of it.
  const L = layoutFloor([fig("tab:1", "coding")], null, [], []);
  const around = planOfficePlacement(req({ zone: "coding" }), L.placed, [], 6);
  ok("a desk a real agent holds is never handed out", !around.some((m) => m.slot === 0));
  ok("the rest of the zone is filled", around.length === ZONE_BY_ID.coding.slots.length - 1);
  ok("and nothing it places is taken over when laid out",
    layoutFloor([fig("tab:1", "coding")], null, [], around).takenOverManualIds.length === 0);

  // Existing manuals are as real as placed figures for occupancy.
  const second = planOfficePlacement(req({ zone: "coding", count: 3 }), L.placed, around, 7);
  ok("a full zone hands out nothing", second.length === 0);

  const over = planOfficePlacement(req({ zone: "coordinator", count: 9 }), [], [], 8);
  ok("asking for more than a zone holds places only what fits", over.length === 1);
}

// --- 4. the store: office events become a drainable queue -------------------
{
  // The queue the store folds office events into (store.ts calls this same
  // function), and the property the connect-time replay depends on: a burst of
  // requests all survive, each with a seq the client can drain from.
  let q = [];
  q = pushOfficeRequest(q, { action: "place", zone: "coding", count: 5, names: [], state: "mixed" });
  q = pushOfficeRequest(q, { action: "place", zone: null, count: null, names: [], state: "mixed" });
  ok("two placements queue rather than replacing each other", q.length === 2);
  ok("seqs are monotonic so a client can drain from where it left off", q.map((r) => r.seq).join() === "1,2");
  ok("the payload survives the queue", q[0].zone === "coding" && q[0].count === 5 && q[1].count === null);

  // Draining: apply everything past the last seq seen, exactly once.
  const seen = 1;
  const pending = q.filter((r) => r.seq > seen);
  ok("draining from a seq replays only what is new", pending.length === 1 && pending[0].seq === 2);

  for (let i = 0; i < 30; i++) q = pushOfficeRequest(q, { action: "place", zone: "coding", count: 1, names: [], state: "idle" });
  ok("the queue is capped", q.length === OFFICE_QUEUE_MAX);
  ok("and keeps the newest", q[q.length - 1].seq === 32);
}

// --- 5. the layer scale ------------------------------------------------------
{
  const src = await import("node:fs").then((fs) => fs.readFileSync(path.resolve(here, "../web/src/layers.ts"), "utf8"));
  const val = (name) => Number(new RegExp(`\\b${name}: (\\d+)`).exec(src)?.[1]);
  const Z = Object.fromEntries(["floor", "sessionSelector", "panel", "chrome", "dock", "float", "overlay", "permission"].map((k) => [k, val(k)]));

  ok("the floor is the bottom layer", Z.floor === 1);
  ok("the session selector sits above the floor", Z.sessionSelector === 10);
  ok("the left/right panels sit above the selector", Z.panel === 20);
  ok("overlays and modals sit above the page", Z.overlay === 50);
  ok("permission prompts are the top layer", Z.permission === 60);
  ok("the whole scale is strictly increasing",
    [Z.floor, Z.sessionSelector, Z.panel, Z.chrome, Z.dock, Z.float, Z.overlay, Z.permission].every((v, i, a) => i === 0 || v > a[i - 1]));

  // Nothing may hand-roll a z-index any more: the scale is the only source.
  const fs = await import("node:fs");
  const dir = path.resolve(here, "../web/src");
  const raw = fs.readdirSync(dir)
    .filter((f) => /\.tsx?$/.test(f) && f !== "layers.ts")
    .filter((f) => /zIndex:\s*\d/.test(fs.readFileSync(path.join(dir, f), "utf8")));
  ok(`no component hand-rolls a z-index${raw.length ? ` (${raw.join(", ")})` : ""}`, raw.length === 0);
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);

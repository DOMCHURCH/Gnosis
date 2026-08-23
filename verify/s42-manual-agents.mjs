// Verify (manual agent placement): imports the SAME sessions.js the browser uses
// and checks the pure placement/takeover logic behind the office-floor's manual
// (decorative, client-only) agents — pinned to a desk, shown in the roster as
// "manual", taken over by a real figure that needs the slot, with invalid slots
// dropped and empty zones expanding once a manual is placed.
//
// The SVG rendering, the popover, drag/resize/detach, and localStorage need a live
// browser and are NOT covered here.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { layoutFloor, ZONE_BY_ID } = await import(pathToFileURL(path.resolve(here, "../web/src/sessions.js")).href);

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

const realFig = (id, zone, state = "thinking") => ({ id, tabId: 1, kind: "tab", name: id.toUpperCase(), zone, state, action: "x", output: [], thinking: [] });

// --- placement on an empty floor --------------------------------------------
{
  const manual = { id: "manual:a", name: "watcher", zone: "coordinator", slot: 0, state: "thinking" };
  const L = layoutFloor([], null, [], [manual]);
  const p = L.placed.find((x) => x.id === "manual:a");
  ok("a manual agent is placed on its pinned desk", !!p && p.manual === true);
  ok("its desk geometry matches the pinned slot", !!p && p.deskX === ZONE_BY_ID.coordinator.slots[0][0] && p.deskY === ZONE_BY_ID.coordinator.slots[0][1]);
  ok("its state drives the figure animation (thinking)", !!p && p.isThinking === true);
  ok("nothing is taken over when the desk was free", L.takenOverManualIds.length === 0);
  const row = L.roster.find((r) => r.id === "manual:a");
  ok('it shows in WHO IS WORKING as "manual" with its state', !!row && row.manual === true && row.action === "manual" && row.tag === "THINKING");
  ok("placing a manual expands its zone (coordinator not collapsed)", L.zoneLabels.find((z) => z.key === "coordinator").count === "1/1");
  ok("other empty zones stay collapsed", L.zoneLabels.find((z) => z.key === "planning").count === "IDLE · 0/2");
}

// --- free desks carry their (zone, slot) for click-to-place ------------------
{
  const L = layoutFloor([realFig("tab:1", "coding")], null, [], []);
  const free = L.freeDesks.find((d) => d.zone === "coding" && d.slot === 1);
  ok("free desks carry zone + slot so a click knows where to place", !!free);
  ok("the occupied coding slot 0 is not offered as free", !L.freeDesks.some((d) => d.zone === "coding" && d.slot === 0));
}

// --- takeover: a real figure that needs a manual's slot claims it ------------
{
  const manual = { id: "manual:b", name: "seat", zone: "coordinator", slot: 0, state: "idle" };
  const L = layoutFloor([realFig("tab:1", "coordinator")], null, [], [manual]);
  ok("the real figure occupies the coordinator desk", L.placed.some((x) => x.id === "tab:1" && x.manual === false && x.deskX === ZONE_BY_ID.coordinator.slots[0][0]));
  ok("the manual on that slot is taken over (reported for removal)", L.takenOverManualIds.includes("manual:b"));
  ok("the taken-over manual is not rendered", !L.placed.some((x) => x.id === "manual:b"));
  ok("and is gone from the roster", !L.roster.some((r) => r.id === "manual:b"));
}

// --- in-zone: manual survives on a slot the real figures don't need ----------
{
  const onSlot0 = { id: "manual:c0", name: "c0", zone: "coding", slot: 0, state: "idle" };
  const onSlot3 = { id: "manual:c3", name: "c3", zone: "coding", slot: 3, state: "speaking" };
  const L = layoutFloor([realFig("tab:1", "coding")], null, [], [onSlot0, onSlot3]);
  ok("a manual on the slot the sole real agent takes is taken over", L.takenOverManualIds.includes("manual:c0"));
  ok("a manual on a further, unneeded slot survives", L.placed.some((x) => x.id === "manual:c3" && x.manual === true && x.isSpeaking === true));
}

// --- invalid / duplicate slots are dropped silently -------------------------
{
  const bad = { id: "manual:x", name: "x", zone: "coordinator", slot: 5, state: "idle" }; // coordinator has 1 slot
  const dup1 = { id: "manual:d1", name: "d1", zone: "planning", slot: 0, state: "idle" };
  const dup2 = { id: "manual:d2", name: "d2", zone: "planning", slot: 0, state: "idle" };
  const L = layoutFloor([], null, [], [bad, dup1, dup2]);
  ok("an out-of-range slot is dropped", L.takenOverManualIds.includes("manual:x") && !L.placed.some((x) => x.id === "manual:x"));
  ok("a duplicate on the same slot is dropped, first kept", L.placed.some((x) => x.id === "manual:d1") && L.takenOverManualIds.includes("manual:d2"));
}

// --- backward compatibility: no manuals behaves exactly as before ------------
{
  const L = layoutFloor([realFig("tab:1", "coding")], null);
  ok("layoutFloor without a manuals arg still works", L.placed.length === 1 && Array.isArray(L.takenOverManualIds) && L.takenOverManualIds.length === 0);
}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

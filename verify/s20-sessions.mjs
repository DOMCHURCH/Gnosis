// Verify (session floors — placement/state logic): imports the SAME sessions.js
// the browser bundle uses (pure ES module, no React) and checks the wiring the
// spec calls for — one floor per tab; within a floor the tab's own figure placed
// by mode/coordination, one figure per background job (application) and per task()
// sub-agent (subagents); the four figure states; fixed slot counts (1·2·8·2·6)
// with overflow to the roster as OFF-FLOOR and a "8/11" zone label; and the rail
// of floors with an activity dot per tab.
//
// The SVG rendering + animations need a live browser and are NOT covered here.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const S = await import(pathToFileURL(path.resolve(here, "../web/src/sessions.js")).href);
const { ZONES, ZONE_BY_ID, figureState, zoneForTab, floorFigures, layoutFloor, sessionsModel, activityFor } = S;

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- slot counts -------------------------------------------------------------
ok("slot counts are coordinator 1, planning 2, application 2, coding 8, subagents 6",
  ZONE_BY_ID.coordinator.slots.length === 1 && ZONE_BY_ID.planning.slots.length === 2 && ZONE_BY_ID.application.slots.length === 2 && ZONE_BY_ID.coding.slots.length === 8 && ZONE_BY_ID.subagents.slots.length === 6);

// --- figureState + zoneForTab ------------------------------------------------
ok("awaiting beats thinking", figureState({ awaitingPermission: true, busy: true }) === "awaiting");
ok("busy → thinking", figureState({ busy: true }) === "thinking");
ok("speaking then idle", figureState({ speaking: true }) === "speaking" && figureState({}) === "idle");
ok("plan mode → planning", zoneForTab({ mode: "plan" }, {}) === "planning");
ok("ask/yolo → coding", zoneForTab({ mode: "ask" }, {}) === "coding" && zoneForTab({ mode: "yolo" }, {}) === "coding");
ok("a tab coordinating sub-agents → coordinator", zoneForTab({ mode: "ask" }, { ownsSub: true }) === "coordinator");

// --- floorFigures: tab + jobs + sub-agents -----------------------------------
const mk = (id, name, mode, extra) => Object.assign({ id, name, mode, busy: false, awaitingPermission: false }, extra);
const state = {
  order: [1, 2],
  agents: { 1: mk(1, "LEDGER", "ask", { busy: true }), 2: mk(2, "HARBOR", "plan") },
  running: { 1: "edit" }, actions: { 1: "reconcile.ts" },
  jobs: { 1: [{ id: "7", command: "vite build" }] },
  subagents: [{ parentId: 1, description: "grep tick(", key: "k1" }, { parentId: 1, description: "index crates", key: "k2" }],
  transcripts: { 1: [{ kind: "tool", ok: true, tool: "read", summary: "24 lines" }, { kind: "line", text: "double-entry passes" }] },
  permission: null, officeFeed: [], speaking: {},
};
let figs = floorFigures(state, 1);
ok("the tab's own figure is present and named", figs.some((f) => f.kind === "tab" && f.name === "LEDGER"));
ok("a running job becomes an application figure with its command", figs.some((f) => f.kind === "job" && f.zone === "application" && f.action === "vite build"));
ok("each task() sub-agent becomes a subagents figure", figs.filter((f) => f.kind === "subagent" && f.zone === "subagents").length === 2);
ok("the busy tab in ask mode with sub-agents sits in coordinator (owns the task)", figs.find((f) => f.kind === "tab").zone === "coordinator");
ok("the tab figure's action is its live activity (tool + target)", figs.find((f) => f.kind === "tab").action === "reconcile.ts");
ok("RECENT OUTPUT is drawn from tool results", figs.find((f) => f.kind === "tab").output.some((o) => /read/.test(o)));

// a plain plan-mode tab with no sub-agents → planning
ok("a plan-mode tab with no sub-agents sits in planning", floorFigures(state, 2).find((f) => f.kind === "tab").zone === "planning");

// --- activityFor: state, never message text ---------------------------------
const A = (over) => ({ ...state, running: {}, actions: {}, ...over });
ok("activity: running a tool shows the tool + target", activityFor(state, 1) === "reconcile.ts");
ok("activity: awaiting approval", activityFor(A({ agents: { ...state.agents, 1: mk(1, "L", "ask", { awaitingPermission: true }) } }), 1) === "awaiting approval");
ok("activity: streaming a reply (busy, no tool) → responding", activityFor(A({ agents: { ...state.agents, 1: mk(1, "L", "ask", { busy: true }) } }), 1) === "responding");
ok("activity: otherwise idle", activityFor(A({ agents: { ...state.agents, 1: mk(1, "L", "ask", {}) } }), 1) === "idle");
ok("activity is NEVER the last assistant sentence", activityFor(A({ actions: { 1: "double-entry passes" }, agents: { ...state.agents, 1: mk(1, "L", "ask", { busy: true }) } }), 1) === "responding");

// --- layout: slot fill + overflow to OFF-FLOOR + "N/total" label ------------
// 10 coding figures on one floor: 8 seated, 2 off-floor, label shows "8/10 · 2 off-floor".
const many = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, tabId: 1, kind: "tab", name: `c-${i}`, zone: "coding", state: "thinking", action: "x", output: [], thinking: [] }));
const L = layoutFloor(many, null);
ok("only 8 figures seat in coding", L.placed.length === 8);
ok("overflow goes to the roster as off-floor, never overlapping", L.offFloor.length === 2);
const codingLabel = L.zoneLabels.find((z) => z.key === "coding");
ok("the coding zone label shows seated/total (8/10)", codingLabel.count.startsWith("8/10"));
ok("the overflow label is amber", codingLabel.countColor === "#FBBF24");
ok("an empty zone collapses to IDLE · 0/slots", L.zoneLabels.find((z) => z.key === "planning").count === "IDLE · 0/2");
ok("off-floor figures still appear in the roster tagged OFF-FLOOR", L.roster.filter((r) => r.tag === "OFF-FLOOR").length === 2);

// --- geometry mirrors the mockup slots --------------------------------------
const g = layoutFloor([{ id: "x", tabId: 1, kind: "tab", name: "x", zone: "coding", state: "thinking", action: "y", output: [], thinking: [] }], "x").placed[0];
ok("placed geometry matches the mockup (desk/agent/ring offsets)", g.deskX === 60 && g.agX === 108 && g.agY === 524 && g.selected === true && !!g.armL);

// --- sessionsModel: rail + global lines --------------------------------------
const m = sessionsModel(state, 1, null);
ok("one floor per tab in the rail", m.floorTabs.length === 2 && m.floorTabs[0].num === "01");
ok("the active floor's dot animates when working", !!m.floorTabs[0].dotAnim);
ok("a tab with an awaiting figure shows an amber dot", (() => { const s2 = { ...state, agents: { ...state.agents, 1: mk(1, "LEDGER", "ask", { awaitingPermission: true }) } }; return sessionsModel(s2, 1, null).floorTabs[0].dot === "#FBBF24"; })());
ok("the global line counts sessions + agents", /2 SESSIONS · \d+ AGENTS/.test(m.globalLine));
ok("the header carries the active session's live tokens + cost", (() => {
  const s2 = { ...state, agents: { ...state.agents, 1: mk(1, "LEDGER", "ask", { busy: true, tokens: 45230, cost: 0.1234 }) } };
  return sessionsModel(s2, 1, null).costLine === "45k tok · $0.1234";
})());
ok("the session header shows the tab name", m.sessionTitle.includes("LEDGER"));

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

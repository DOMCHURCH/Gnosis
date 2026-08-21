// Verify (office view — placement/state logic): imports the SAME office.js the
// browser bundle uses (pure ES module, no React) and checks the wiring the spec
// calls for — zone by mode/jobs/sub-agents/coordinator, the four figure states,
// fixed slot counts with overflow to the roster (off-floor, never overlapping),
// sub-agents appearing/leaving, and the awaiting action from the permission.
//
// The SVG rendering + animations need a live browser and are NOT covered here.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { ZONES, STATE_COLOR, zoneForAgent, stateForAgent, officeModel, agentGeom } = await import(pathToFileURL(path.resolve(here, "../web/src/office.js")).href);

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- slot counts -------------------------------------------------------------
ok("coding has 4 slots, sub-agents 3, others 1", ZONES.coding.slots.length === 4 && ZONES.subagents.slots.length === 3 && ZONES.coordinator.slots.length === 1 && ZONES.planning.slots.length === 1 && ZONES.application.slots.length === 1);

// --- zoneForAgent ------------------------------------------------------------
ok("ask mode → coding", zoneForAgent({ mode: "ask" }, {}) === "coding");
ok("yolo mode → coding", zoneForAgent({ mode: "yolo" }, {}) === "coding");
ok("plan mode → planning", zoneForAgent({ mode: "plan" }, {}) === "planning");
ok("owns a running sub-agent → coordinator", zoneForAgent({ mode: "ask" }, { ownsSub: true }) === "coordinator");
ok("a running job → application", zoneForAgent({ mode: "ask" }, { hasJob: true }) === "application");
ok("coordinator beats job", zoneForAgent({ mode: "plan" }, { ownsSub: true, hasJob: true }) === "coordinator");
ok("job beats plan mode", zoneForAgent({ mode: "plan" }, { hasJob: true }) === "application");

// --- stateForAgent -----------------------------------------------------------
ok("awaiting beats busy", stateForAgent({ awaitingPermission: true, busy: true }) === "awaiting");
ok("busy beats speaking", stateForAgent({ busy: true, speaking: true }) === "busy");
ok("speaking beats idle", stateForAgent({ speaking: true }) === "speaking");
ok("otherwise idle", stateForAgent({}) === "idle");

// --- officeModel placement ---------------------------------------------------
const mk = (id, name, mode, extra) => Object.assign({ id, name, mode, busy: false, awaitingPermission: false }, extra);
const state = {
  order: [1, 2, 3, 4],
  agents: { 1: mk(1, "c-01", "ask", { busy: true }), 2: mk(2, "p-01", "plan"), 3: mk(3, "a-01", "ask"), 4: mk(4, "ORCH", "ask") },
  running: { 1: "edit" }, jobs: { 3: ["job1"] }, subagents: [{ parentId: 4, description: "find X", key: "k1" }],
  transcripts: {}, actions: { 1: "edit session.ts" }, permission: null,
};
let m = officeModel(state);
const zoneOf = (id) => { for (const z of Object.keys(ZONES)) if (m.placed.some((a) => a.id === id && a.zone === z)) return z; return null; };
ok("busy ask agent → coding", zoneOf(1) === "coding");
ok("plan agent → planning", zoneOf(2) === "planning");
ok("agent with a job → application", zoneOf(3) === "application");
ok("agent owning a sub-agent → coordinator", zoneOf(4) === "coordinator");
ok("the sub-agent is a figure on Sub-agents", m.placed.some((a) => a.kind === "subagent" && a.zone === "subagents" && a.name === "find X".slice(0, 8)));
ok("busy agent action comes from state.actions", m.placed.find((a) => a.id === 1).action === "edit session.ts");

// --- overflow to the roster (off-floor) --------------------------------------
const many = { order: [1, 2, 3, 4, 5], agents: {}, running: {}, jobs: {}, subagents: [], transcripts: {}, actions: {}, permission: null };
for (let i = 1; i <= 5; i++) many.agents[i] = mk(i, `c-0${i}`, "ask"); // all coding, only 4 slots
m = officeModel(many);
ok("only 4 agents fit the coding zone", m.placed.filter((a) => a.zone === "coding").length === 4);
ok("the 5th coding agent goes off-floor (roster), not overlapping", m.offFloor.length === 1);

// --- sub-agents leave --------------------------------------------------------
m = officeModel({ ...state, subagents: [] });
ok("a returned sub-agent leaves the floor", !m.placed.some((a) => a.kind === "subagent"));

// --- awaiting action from the permission preview -----------------------------
const await1 = { ...state, agents: { ...state.agents, 1: mk(1, "c-01", "ask", { awaitingPermission: true }) }, permission: { tabId: 1, id: "1:1", preview: { kind: "bash", command: "rm -rf ./legacy" } } };
m = officeModel(await1);
const a1 = m.placed.find((a) => a.id === 1);
ok("an awaiting agent's state is 'awaiting'", a1.state === "awaiting");
ok("its action is the permission preview command", a1.action === "rm -rf ./legacy");
ok("awaiting is counted", m.awaiting === 1);

// --- geometry mirrors the mockup slots --------------------------------------
const g = agentGeom({ id: 1, name: "c", action: "x", state: "busy", color: "#22D3EE", slotX: 96, slotY: 600, zone: "coding" }, 1);
ok("agentGeom desk/agent offsets match the mockup", g.deskX === 96 && g.agX === 144 && g.agY === 504 && g.selected === true);
ok("busy agent gets arm animations", !!g.armAnimL && !!g.armAnimR);

ok("state colors match the palette", STATE_COLOR.busy === "#22D3EE" && STATE_COLOR.awaiting === "#FBBF24" && STATE_COLOR.speaking === "#E879F9");

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

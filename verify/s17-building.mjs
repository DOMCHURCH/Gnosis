// Verify (web UI phase 3 — the building's LOGIC): imports the SAME floors.js the
// browser bundle uses (a pure ES module, no React) and checks the state→floor
// mapping that drives the visualization — an agent's floor from its state, plan
// mode moving it to Planning, an active edit to Coding, a job to Application, and
// sub-agents appearing/leaving on the Sub-agents floor.
//
// The SVG rendering + animations themselves need a live browser and are NOT
// covered here (see the commit note).
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { FLOORS, floorForAgent, buildingInput, deriveBuilding } = await import(pathToFileURL(path.resolve(here, "../web/src/floors.js")).href);

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- floors + floorForAgent --------------------------------------------------
ok("the five floors are in spec order", JSON.stringify(FLOORS) === JSON.stringify(["Coordinator", "Planning", "Coding", "Application", "Sub-agents"]));
ok("an idle ask-mode agent stands on Coordinator", floorForAgent({ mode: "ask", editing: false, hasJob: false }) === "Coordinator");
ok("plan mode → Planning", floorForAgent({ mode: "plan", editing: false, hasJob: false }) === "Planning");
ok("an active edit → Coding", floorForAgent({ mode: "ask", editing: true, hasJob: false }) === "Coding");
ok("a running job → Application", floorForAgent({ mode: "ask", editing: false, hasJob: true }) === "Application");
ok("plan takes precedence over an edit", floorForAgent({ mode: "plan", editing: true, hasJob: false }) === "Planning");
ok("an edit takes precedence over a job", floorForAgent({ mode: "ask", editing: true, hasJob: true }) === "Coding");

// --- buildingInput derives editing/hasJob from store state ------------------
const store = {
  order: [1, 2],
  agents: { 1: { id: 1, name: "main", mode: "ask", busy: true }, 2: { id: 2, name: "worker", mode: "plan", busy: false } },
  running: { 1: "edit", 2: null },
  jobs: { 1: [], 2: [] },
  subagents: [],
  links: [],
};
const input = buildingInput(store);
ok("buildingInput marks a write/edit-running agent as editing", input.agents[1].editing === true);
ok("buildingInput carries mode + busy through", input.agents[2].mode === "plan" && input.agents[1].busy === true);

// --- deriveBuilding places figures + moves them on state change -------------
let b = deriveBuilding(input);
ok("the editing agent lands on Coding", b.floors["Coding"].some((f) => f.id === 1));
ok("the plan agent lands on Planning", b.floors["Planning"].some((f) => f.id === 2));
ok("a busy agent's figure is marked busy", b.floors["Coding"].find((f) => f.id === 1).busy === true);

// toggle agent 1 out of editing → it moves to Coordinator
b = deriveBuilding(buildingInput({ ...store, running: { 1: null, 2: null } }));
ok("clearing the edit moves the agent to Coordinator", b.floors["Coordinator"].some((f) => f.id === 1) && !b.floors["Coding"].some((f) => f.id === 1));

// a running job puts it on Application
b = deriveBuilding(buildingInput({ ...store, running: { 1: null }, jobs: { 1: ["job7"] } }));
ok("a running job puts the agent on Application", b.floors["Application"].some((f) => f.id === 1));

// --- sub-agents appear and leave --------------------------------------------
b = deriveBuilding(buildingInput({ ...store, subagents: [{ parentId: 1, description: "find X", key: "k1" }] }));
ok("a spawned sub-agent appears on the Sub-agents floor", b.floors["Sub-agents"].some((f) => f.kind === "subagent" && f.name === "find X"));
b = deriveBuilding(buildingInput({ ...store, subagents: [] }));
ok("the sub-agent leaves when it returns", b.floors["Sub-agents"].length === 0);

// --- awaiting permission + message links pass through -----------------------
b = deriveBuilding(buildingInput({ ...store, agents: { ...store.agents, 1: { ...store.agents[1], awaitingPermission: true } }, running: { 1: null } }));
ok("an agent awaiting permission is flagged on its figure", b.floors["Coordinator"].find((f) => f.id === 1).awaitingPermission === true);
b = deriveBuilding(buildingInput({ ...store, links: [{ from: 1, to: 2, key: "main->worker" }] }));
ok("a tab-to-tab message link is passed to the renderer", b.links.length === 1 && b.links[0].from === 1 && b.links[0].to === 2);

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

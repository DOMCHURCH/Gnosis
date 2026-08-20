// The building model — PURE logic that maps agent state to floors. Kept as a
// plain ES module (no React, no types) so the exact same code runs in the browser
// bundle AND in the Node verify suite; the visualization in Building.tsx is a thin
// SVG renderer over what these functions return.
//
// Floors, top to bottom in the spec's order:
export const FLOORS = ["Coordinator", "Planning", "Coding", "Application", "Sub-agents"];

/**
 * Which floor an agent stands on, from its current state. Precedence: mode (plan)
 * is the strongest signal, then an in-flight edit, then a running background job,
 * else it waits on the Coordinator floor.
 */
export function floorForAgent(a) {
  if (a.mode === "plan") return "Planning";
  if (a.editing) return "Coding";
  if (a.hasJob) return "Application";
  return "Coordinator";
}

/**
 * Project the store state into a per-agent view the building renders from:
 * `editing` is true while the running tool is a write/edit; `hasJob` while the
 * agent owns a running background job.
 */
export function buildingInput(state) {
  const agents = {};
  for (const id of state.order) {
    const a = state.agents[id];
    if (!a) continue;
    const run = state.running ? state.running[id] : null;
    agents[id] = {
      id: a.id,
      name: a.name,
      mode: a.mode,
      busy: !!a.busy,
      awaitingPermission: !!a.awaitingPermission,
      editing: run === "edit" || run === "write",
      hasJob: !!(state.jobs && state.jobs[id] && state.jobs[id].length > 0),
    };
  }
  return { order: state.order, agents, subagents: state.subagents || [], links: state.links || [] };
}

/**
 * Place every agent (and every live sub-agent) on a floor. Sub-agents are their
 * own figures on the Sub-agents floor and vanish when they return. Returns
 * `{ floors: {name: figure[]}, links }` for the renderer.
 */
export function deriveBuilding(input) {
  const floors = {};
  for (const f of FLOORS) floors[f] = [];
  for (const id of input.order) {
    const a = input.agents[id];
    if (!a) continue;
    floors[floorForAgent(a)].push({
      id: a.id,
      name: a.name,
      kind: "agent",
      busy: !!a.busy,
      awaitingPermission: !!a.awaitingPermission,
    });
  }
  for (const s of input.subagents || []) {
    floors["Sub-agents"].push({ id: `sub:${s.parentId}:${s.key}`, name: s.description, kind: "subagent", parentId: s.parentId, busy: true });
  }
  return { floors, links: input.links || [] };
}

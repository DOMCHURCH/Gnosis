// Office-floor model — PURE logic ported from the Claude Design mockup's ZONES /
// agentVals / renderVals, driven by dom's live event-bus state instead of a SEED.
// Kept as a plain ES module (no React) so the browser and the Node verify run the
// exact same code. The SVG geometry constants match the mockup 1:1 (1280×800).

export const ZONES = {
  coordinator: { label: "01 COORDINATOR", color: "#E879F9", slots: [[64, 328]] },
  planning: { label: "02 PLANNING", color: "#818CF8", slots: [[416, 328]] },
  coding: { label: "03 CODING", color: "#22D3EE", slots: [[96, 600], [264, 600], [432, 600], [600, 600]] },
  application: { label: "04 APPLICATION", color: "#4ADE80", slots: [[816, 352]] },
  subagents: { label: "05 SUB-AGENTS", color: "#C084FC", slots: [[816, 664], [960, 664], [1104, 664]] },
};
export const STATE_COLOR = { busy: "#22D3EE", awaiting: "#FBBF24", speaking: "#E879F9", idle: "#6B6B7B" };

const LABEL_POS = {
  coordinator: [88, 144], planning: [432, 144], application: [824, 144], coding: [592, 412], subagents: [944, 744],
};

/** Which zone a live agent (a tab) stands in, from its state. Sub-agent figures are
 * placed in `subagents` separately. Priority: owns running sub-agents (it's
 * coordinating) → coordinator; a running background job → application; plan mode →
 * planning; otherwise (ask/yolo) → coding. */
export function zoneForAgent(agent, ctx) {
  if (ctx && ctx.ownsSub) return "coordinator";
  if (ctx && ctx.hasJob) return "application";
  if (agent.mode === "plan") return "planning";
  return "coding";
}

/** Agent activity state → the mockup's four figure states. */
export function stateForAgent(a) {
  if (a.awaitingPermission) return "awaiting";
  if (a.busy) return "busy";
  if (a.speaking) return "speaking";
  return "idle";
}

function previewLabel(p) {
  if (!p) return "";
  if (p.kind === "bash") return p.command;
  if (p.kind === "http") return `${p.method} ${p.url}`;
  if (p.kind === "diff") return `${p.tool} ${p.path}`;
  return "";
}

function actionFor(state, id, st) {
  if (st === "awaiting" && state.permission && state.permission.tabId === id) return previewLabel(state.permission.preview) || "awaiting approval";
  const a = state.actions ? state.actions[id] : null;
  if (a) return a;
  return st === "busy" ? "working" : st === "speaking" ? "…" : "idle";
}

function thinkingFor(state, id) {
  const items = (state.transcripts && state.transcripts[id]) || [];
  const lines = [];
  for (let i = items.length - 1; i >= 0 && lines.length < 6; i--) {
    const it = items[i];
    if (it.kind === "tool") lines.unshift(`${it.ok ? "✓" : "✗"} ${it.tool} — ${it.summary}`);
    else if (it.text) lines.unshift(it.text);
  }
  return lines;
}

/**
 * Project the store state into the office model: real agents placed by zone,
 * sub-agents as their own figures in the Sub-agents zone, both filling fixed slot
 * counts. Overflow agents go off-floor (roster only), never overlapping.
 */
export function officeModel(state, debugAgents) {
  const subByParent = {};
  for (const s of state.subagents || []) subByParent[s.parentId] = (subByParent[s.parentId] || 0) + 1;

  const live = state.order
    .map((id) => state.agents[id])
    .filter(Boolean)
    .map((a) => {
      const ctx = { ownsSub: !!subByParent[a.id], hasJob: !!(state.jobs && state.jobs[a.id] && state.jobs[a.id].length) };
      const zone = zoneForAgent(a, ctx);
      const st = stateForAgent(a);
      return { id: a.id, name: a.name, kind: "agent", zone, state: st, action: actionFor(state, a.id, st), thinking: thinkingFor(state, a.id), color: ZONES[zone].color };
    });

  const subs = (state.subagents || []).map((s) => ({
    id: `sub:${s.parentId}:${s.key}`, name: (s.description || "task").slice(0, 8), kind: "subagent", zone: "subagents",
    state: "busy", action: s.description || "sub-task", thinking: [`spawned by tab ${s.parentId}`], color: ZONES.subagents.color,
  }));

  // Debug overlay (window.domOffice.add) — display-only synthetic agents.
  const extra = (debugAgents || []).map((a) => {
    const zone = ZONES[a.zone] ? a.zone : "coding";
    return { id: a.id, name: a.name || a.id, kind: "agent", zone, state: STATE_COLOR[a.state] ? a.state : "busy", action: a.action || "booting", thinking: a.thinking || ["debug agent"], color: a.color || ZONES[zone].color };
  });

  const all = [...live, ...subs, ...extra];
  const used = {};
  const placed = [];
  const offFloor = [];
  for (const a of all) {
    const list = used[a.zone] || (used[a.zone] = []);
    const slot = ZONES[a.zone].slots[list.length];
    if (slot) { const idx = list.length; list.push(a.id); placed.push({ ...a, slotX: slot[0], slotY: slot[1], slotIdx: idx }); }
    else offFloor.push(a);
  }

  const freeDesks = Object.keys(ZONES).reduce((acc, z) => {
    const taken = (used[z] || []).length;
    ZONES[z].slots.slice(taken).forEach((sl) => acc.push({ x: sl[0], y: sl[1] }));
    return acc;
  }, []);

  const zoneCounts = Object.keys(ZONES).map((z) => {
    const n = all.filter((a) => a.zone === z).length;
    const blocked = all.filter((a) => a.zone === z && a.state === "awaiting").length;
    const p = LABEL_POS[z];
    return {
      key: z,
      left: `${((p[0] / 1280) * 100).toFixed(2)}%`,
      top: `${((p[1] / 800) * 100).toFixed(2)}%`,
      text: n === 0 ? "idle · no agents" : `${n}${n === 1 ? " agent" : " agents"}${blocked ? ` · ${blocked} blocked` : ""}`,
    };
  });

  return { placed, offFloor, freeDesks, zoneCounts, awaiting: all.filter((a) => a.state === "awaiting").length };
}

/** Pixel geometry for one placed agent — mirrors the mockup's agentVals(). */
export function agentGeom(a, selectedId) {
  const idle = a.state === "idle";
  const short = a.action.length > 12 ? a.action.slice(0, 11) + "…" : a.action;
  const busy = a.state === "busy";
  return {
    id: a.id, name: a.name, color: a.color, opacity: idle ? 0.5 : 1,
    deskX: a.slotX, deskY: a.slotY, agX: a.slotX + 48, agY: a.slotY - 96,
    armAnimL: busy ? { animation: "domArmA .5s ease-in-out infinite" } : undefined,
    armAnimR: busy ? { animation: "domArmB .5s ease-in-out infinite" } : undefined,
    plateStroke: a.state === "awaiting" ? "#FBBF24" : "#2A2A38",
    labelLeft: `${(((a.slotX + 80) / 1280) * 100).toFixed(2)}%`,
    labelTop: `${(((a.slotY - 104) / 800) * 100).toFixed(2)}%`,
    short, stateColor: STATE_COLOR[a.state] || "#6B6B7B",
    cueX: a.slotX + 120, cueY: a.slotY - 88, cueYBig: a.slotY - 96,
    isBusy: busy, isAwait: a.state === "awaiting", isSpeak: a.state === "speaking",
    selected: a.id === selectedId, ringX: a.slotX + 40, ringY: a.slotY - 104,
  };
}

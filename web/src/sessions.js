// Session-floors model — PURE logic ported from the Claude Design "Dom Sessions"
// mockup (ZONES / colorOf / renderVals), driven by dom's live event-bus state.
// One floor = one dom tab (session). Within a floor, figures come from that tab:
// its own agent (placed by mode / coordination), one per running background job,
// and one per running task() sub-agent. Kept as plain JS so the browser bundle
// and the Node verify run identical code. Geometry constants match the mockup 1:1
// (1440×900).

export const ZONES = [
  { id: "coordinator", name: "01 COORDINATOR", color: "#E879F9", x: 40, y: 96, w: 368, d: 304, label: [56, 116], slots: [[100, 344]] },
  { id: "planning", name: "02 PLANNING", color: "#818CF8", x: 416, y: 96, w: 352, d: 304, label: [432, 116], slots: [[440, 344], [600, 344]] },
  { id: "application", name: "04 APPLICATION", color: "#4ADE80", x: 776, y: 96, w: 632, d: 304, label: [792, 116], slots: [[800, 344], [960, 344]] },
  { id: "coding", name: "03 CODING", color: "#22D3EE", x: 40, y: 408, w: 728, d: 452, label: [56, 428], slots: [[60, 620], [240, 620], [420, 620], [600, 620], [60, 800], [240, 800], [420, 800], [600, 800]] },
  { id: "subagents", name: "05 SUB-AGENTS", color: "#C084FC", x: 776, y: 408, w: 632, d: 452, label: [792, 428], slots: [[800, 620], [980, 620], [1160, 620], [800, 800], [980, 800], [1160, 800]] },
];
export const ZONE_BY_ID = {};
ZONES.forEach((z) => { ZONE_BY_ID[z.id] = z; });

export const STATE_COLOR = { thinking: "#22D3EE", awaiting: "#FBBF24", speaking: "#E879F9", idle: "#6B6B7B" };
const VARIANTS = {
  coordinator: ["#E879F9"], planning: ["#818CF8", "#A5ADFB"],
  coding: ["#22D3EE", "#5BE1F2", "#818CF8", "#C084FC", "#22D3EE", "#5BE1F2", "#818CF8", "#C084FC"],
  application: ["#4ADE80", "#86E9AC"], subagents: ["#C084FC", "#D6ACFD", "#818CF8", "#C084FC", "#D6ACFD", "#818CF8"],
};

const ZONE_HINT = {
  coordinator: "routes work when sub-agents are running",
  planning: "this session in plan mode",
  coding: "this session editing",
  application: "background jobs and dev servers",
  subagents: "spawned by task()",
};

export const pctX = (v) => `${((v / 1440) * 100).toFixed(2)}%`;
export const pctY = (v) => `${((v / 900) * 100).toFixed(2)}%`;

/** Compact token count for the header (1_234 → "1.2k", 45_000 → "45k"). */
function fmtTokens(n) {
  if (!n || n < 0) return "0";
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function colorOf(zoneId, idx) {
  const pal = VARIANTS[zoneId] || [(ZONE_BY_ID[zoneId] || {}).color || "#6B6B7B"];
  return pal[Math.max(0, idx) % pal.length];
}

/** The tab's own figure state → the mockup's four figure states. */
export function figureState(tab) {
  if (tab.awaitingPermission) return "awaiting";
  if (tab.busy) return "thinking";
  if (tab.speaking) return "speaking";
  return "idle";
}

/** The tab's live ACTIVITY line — its state, never its message text:
 *  - running a tool → the tool and its target (e.g. "read src/engine.ts")
 *  - awaiting approval → "awaiting approval"
 *  - streaming a reply (busy, no tool) → "responding"
 *  - otherwise → "idle"
 * The tool label comes from state.actions, which tool.start sets to the tool +
 * its target; it is only consulted while a tool is actually running. */
export function activityFor(state, tabId) {
  const tab = state.agents && state.agents[tabId];
  if (!tab) return "idle";
  if (tab.awaitingPermission) return "awaiting approval";
  const running = state.running && state.running[tabId];
  if (running) return (state.actions && state.actions[tabId]) || running;
  if (tab.busy) return "responding";
  return "idle";
}

function recentText(state, tabId, kinds, n) {
  const items = (state.transcripts && state.transcripts[tabId]) || [];
  const out = [];
  for (let i = items.length - 1; i >= 0 && out.length < n; i--) {
    const it = items[i];
    if (kinds === "tool") { if (it.kind === "tool") out.unshift(`${it.ok ? "✓" : "✗"} ${it.tool} · ${it.summary}`); }
    else if (it.kind !== "tool" && it.text) out.unshift(it.text);
  }
  return out;
}

/** Which zone the tab's own figure stands in: coordinating sub-agents → coordinator;
 * plan mode → planning; otherwise (ask/yolo) → coding. Jobs and sub-agents are their
 * own figures (application / subagents). */
export function zoneForTab(tab, ctx) {
  if (ctx && ctx.ownsSub) return "coordinator";
  if (tab.mode === "plan") return "planning";
  return "coding";
}

/** All figures for one floor (tab): its own agent + one per running job + one per
 * running sub-agent. `tabId` is stamped on each so STEER/DISMISS route correctly. */
export function floorFigures(state, tabId) {
  const tab = state.agents[tabId];
  if (!tab) return [];
  const subs = (state.subagents || []).filter((s) => s.parentId === tabId);
  const jobs = (state.jobs && state.jobs[tabId]) || [];
  const st = figureState(tab);
  const figs = [
    { id: `tab:${tabId}`, tabId, kind: "tab", name: tab.name, zone: zoneForTab(tab, { ownsSub: subs.length > 0 }), state: st, action: activityFor(state, tabId), output: recentText(state, tabId, "tool", 3), thinking: recentText(state, tabId, "line", 3) },
  ];
  for (const j of jobs) figs.push({ id: `job:${j.id}`, tabId, kind: "job", name: `job ${j.id}`, zone: "application", state: "thinking", action: j.command || "background job", output: [], thinking: [`background job ${j.id}`] });
  for (const s of subs) figs.push({ id: `sub:${s.key}`, tabId, kind: "subagent", name: (s.description || "task").slice(0, 8), zone: "subagents", state: "thinking", action: s.description || "sub-task", output: [], thinking: [`spawned by ${tab.name}`] });
  return figs;
}

/** Place a floor's figures into fixed zone slots (coordinator 1, planning 2,
 * application 2, coding 8, subagents 6); overflow goes off-floor (roster only),
 * never overlapping. Returns everything the renderer needs. Mirrors renderVals(). */
export function layoutFloor(figures, selectedId, debugFigures) {
  const all = [...figures, ...(debugFigures || [])];
  const byZone = {};
  const offFloor = [];
  ZONES.forEach((z) => { byZone[z.id] = []; });
  // colour index per zone across ALL figures (matches the mockup's colorOf peers)
  const zoneIndex = {};
  const colorById = {};
  for (const a of all) {
    const zid = ZONE_BY_ID[a.zone] ? a.zone : "coding";
    const i = (zoneIndex[zid] = (zoneIndex[zid] || 0));
    colorById[a.id] = a.color || colorOf(zid, i);
    zoneIndex[zid] = i + 1;
    if (byZone[zid].length < ZONE_BY_ID[zid].slots.length) byZone[zid].push(a);
    else offFloor.push(a);
  }

  const zonePlates = [], zoneCurbs = [], zoneLabels = [], freeDesks = [], placed = [], nameTags = [];
  ZONES.forEach((zone) => {
    const list = byZone[zone.id];
    const total = all.filter((a) => (ZONE_BY_ID[a.zone] ? a.zone : "coding") === zone.id).length;
    const collapsed = list.length === 0;
    const stripH = 76;
    zonePlates.push({ key: zone.id, x: zone.x, y: zone.y, w: zone.w, h: collapsed ? stripH : zone.d, fill: zone.color, op: collapsed ? 0.03 : 0.055 });
    zoneCurbs.push({ key: `${zone.id}-l`, x: zone.x, y: zone.y, w: 8, h: collapsed ? stripH : zone.d, fill: zone.color, op: collapsed ? 0.35 : 0.9 });
    zoneCurbs.push({ key: `${zone.id}-b`, x: zone.x, y: zone.y + (collapsed ? stripH - 6 : zone.d - 6), w: zone.w, h: 6, fill: zone.color, op: collapsed ? 0.18 : 0.4 });
    zoneLabels.push({
      key: zone.id, left: pctX(zone.label[0]), top: pctY(zone.label[1]),
      accent: collapsed ? "#6B6B7B" : zone.color, name: zone.name,
      count: collapsed ? `IDLE · 0/${zone.slots.length}` : (total > zone.slots.length ? `${list.length}/${total} · ${total - list.length} off-floor` : `${list.length}/${zone.slots.length}`),
      countColor: total > zone.slots.length ? "#FBBF24" : "#6B6B7B",
      // When empty, one dim line explaining what would put an agent here.
      hint: collapsed ? ZONE_HINT[zone.id] : "",
    });
    if (collapsed) return;
    zone.slots.forEach((sl, i) => { if (i >= list.length) freeDesks.push({ key: `${zone.id}-f${i}`, x: sl[0], y: sl[1] }); });
    list.forEach((a, i) => {
      const sl = zone.slots[i];
      const color = colorById[a.id];
      placed.push({
        key: a.id, id: a.id, color, opacity: a.state === "idle" ? 0.55 : 1,
        deskX: sl[0], deskY: sl[1], agX: sl[0] + 48, agY: sl[1] - 96,
        armL: a.state === "thinking" ? { animation: "domArmA .34s ease-in-out infinite" } : undefined,
        armR: a.state === "thinking" ? { animation: "domArmB .34s ease-in-out infinite" } : undefined,
        cueX: sl[0] + 128, cueY: sl[1] - 72, cueYBig: sl[1] - 84,
        isThinking: a.state === "thinking", isAwaiting: a.state === "awaiting", isSpeaking: a.state === "speaking",
        selected: a.id === selectedId, ringX: sl[0] + 40, ringY: sl[1] - 104,
      });
      nameTags.push({ key: `${a.id}-t`, left: pctX(sl[0] + 80), top: pctY(sl[1] - 130), name: a.name, stateColor: STATE_COLOR[a.state] || "#6B6B7B", border: a.state === "awaiting" ? "#FBBF24" : "#2A2A38" });
    });
  });

  const roster = all.map((a) => {
    const off = offFloor.indexOf(a) !== -1;
    return {
      key: a.id, id: a.id, name: a.name, action: a.action,
      accent: off ? "#2A2A38" : (ZONE_BY_ID[a.zone] || ZONE_BY_ID.coding).color,
      color: off ? "#6B6B7B" : colorById[a.id],
      tag: off ? "OFF-FLOOR" : a.state.toUpperCase(),
      stateColor: off ? "#6B6B7B" : (STATE_COLOR[a.state] || "#6B6B7B"),
      bg: a.id === selectedId ? "#1D1D27" : "transparent",
      opacity: off ? 0.6 : 1,
    };
  });

  return { zonePlates, zoneCurbs, zoneLabels, freeDesks, placed, nameTags, roster, offFloor, colorById };
}

/** The whole view model: the rail of floors, the active floor's layout + figures,
 * and the global header lines. `debugByFloor[tabId]` are window.domOffice overlays. */
export function sessionsModel(state, activeId, selectedId, debugByFloor) {
  const order = state.order || [];
  const active = activeId != null && state.agents[activeId] ? activeId : order[0] ?? null;

  const floorTabs = order.map((id, i) => {
    const figs = floorFigures(state, id);
    const working = figs.filter((a) => a.state === "thinking" || a.state === "speaking").length;
    const awaiting = figs.some((a) => a.state === "awaiting");
    const on = id === active;
    return {
      key: id, id, num: String(i + 1).padStart(2, "0"),
      bg: on ? "#1D1D27" : "#101017", fg: on ? "#C9C9D6" : "#6B6B7B",
      border: on ? "#6B6B7B" : "#2A2A38", accent: on ? "#22D3EE" : "#2A2A38",
      dot: awaiting ? "#FBBF24" : working ? "#22D3EE" : "#2A2A38",
      dotAnim: working ? { animation: "domTab 1.4s ease-in-out infinite" } : undefined,
    };
  });

  const figs = active != null ? floorFigures(state, active) : [];
  const layout = layoutFloor(figs, selectedId, active != null && debugByFloor ? debugByFloor[active] : []);
  const tab = active != null ? state.agents[active] : null;
  const working = figs.filter((a) => a.state === "thinking" || a.state === "speaking").length;
  const floorAwaiting = figs.filter((a) => a.state === "awaiting").length;
  const awaitingAll = order.reduce((n, id) => n + floorFigures(state, id).filter((a) => a.state === "awaiting").length, 0);
  const totalAgents = order.reduce((n, id) => n + floorFigures(state, id).length, 0);
  const idx = order.indexOf(active);

  return {
    floorTabs,
    activeId: active,
    layout,
    awaitingLine: `${awaitingAll}${awaitingAll === 1 ? " AWAITING APPROVAL" : " AWAITING APPROVALS"}`,
    globalLine: `${order.length} SESSIONS · ${totalAgents} AGENTS`,
    // Live session totals for the active tab (per-message cost stays gone).
    costLine: tab ? `${fmtTokens(tab.tokens)} tok · $${(tab.cost || 0).toFixed(4)}` : "",
    sessionTitle: tab ? `${String(idx + 1).padStart(2, "0")} · ${tab.name}` : "—",
    sessionTask: tab ? activityFor(state, active) : "no session",
    sessionAccent: floorAwaiting ? "#FBBF24" : working ? "#22D3EE" : "#2A2A38",
    sessionState: floorAwaiting ? `${floorAwaiting} BLOCKED` : working ? `${working} WORKING` : "PARKED",
    sessionStateColor: floorAwaiting ? "#FBBF24" : working ? "#22D3EE" : "#6B6B7B",
    offFloorLine: layout.offFloor.length ? `${layout.offFloor.length} OFF-FLOOR` : "ALL SEATED",
    offFloorColor: layout.offFloor.length ? "#FBBF24" : "#6B6B7B",
    ctxLine: `${figs.length} agents · ${state.order.length} sessions`,
    chatHeader: tab ? `CHAT · ${tab.name}` : "CHAT",
  };
}

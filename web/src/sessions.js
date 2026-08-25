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

/** The three agent colour variants. A figure's colour decides its variant, and the
 * variant gives it one small silhouette/desk difference so two agents of different
 * colours are still distinguishable when the floor is zoomed out and the name tags
 * are unreadable: VAR-A gets a monitor glow in its own colour, VAR-B stands a touch
 * taller, VAR-C works a second monitor. */
export function variantOf(color) {
  const c = String(color || "").toUpperCase();
  if (c === "#22D3EE" || c === "#5BE1F2") return "A"; // cyan
  if (c === "#4ADE80" || c === "#86E9AC") return "C"; // green
  return "B";                                        // purple / indigo family
}

/** Depth geometry shared by every zone box: a lit ceiling strip at the top, light
 * top/left borders and dark bottom/right ones so the box reads as a room seen from
 * slightly above rather than a flat rectangle. */
export const ZONE_DEPTH = { border: 2, ceiling: 3, lightEdge: "#2A2A38", darkEdge: "#1a1a22", ceilingFill: "#3a3a4a", idleOpacity: 0.6 };

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

/** Geometry for one seated figure at desk slot `sl` = [x, y]. Shared by real,
 * debug, and manual figures so they line up on the desks identically. */
function placeFigure(id, color, state, sl, selectedId, manual, zone, slot, name) {
  const variant = variantOf(color);
  const agX = sl[0] + 48, agY = sl[1] - 96;
  // Working agents grow 10% and pick up a soft cyan glow; VAR-B stands 7% taller.
  // Both are one transform about the figure's foot line so it never leaves the desk.
  const s = state === "thinking" ? 1.1 : 1;
  const sy = s * (variant === "B" ? 1.07 : 1);
  const cx = agX + 32, by = agY + 96;
  return {
    key: id, id, color, variant,
    // Identity/placement carried through for the 3D floor, which seats figures by
    // (zone, slot) rather than by the SVG's pixel coordinates. Unused by the SVG.
    zone, slot, name, state,
    // Idle agents sit at 90% opacity — present, but not competing with the working
    // ones for attention. Manual (decorative) figures stay dimmer still.
    opacity: state === "idle" ? (manual ? 0.4 : 0.9) : (manual ? 0.72 : 1),
    manual: !!manual,
    figTransform: s === 1 && sy === 1 ? undefined : `translate(${cx} ${by}) scale(${s.toFixed(3)} ${sy.toFixed(3)}) translate(${-cx} ${-by})`,
    figFilter: state === "thinking" ? "drop-shadow(0 0 6px #22D3EE88)" : undefined,
    deskGlow: variant === "A",        // VAR-A: monitor glow in the agent's colour
    deskSecondMonitor: variant === "C", // VAR-C: a second monitor on the desk
    deskX: sl[0], deskY: sl[1], agX, agY,
    armL: state === "thinking" ? { animation: "domArmA .34s ease-in-out infinite" } : undefined,
    armR: state === "thinking" ? { animation: "domArmB .34s ease-in-out infinite" } : undefined,
    cueX: sl[0] + 128, cueY: sl[1] - 72, cueYBig: sl[1] - 84,
    isThinking: state === "thinking", isAwaiting: state === "awaiting", isSpeaking: state === "speaking",
    selected: id === selectedId, ringX: sl[0] + 40, ringY: sl[1] - 104,
  };
}

/** Place a floor's figures into fixed zone slots (coordinator 1, planning 2,
 * application 2, coding 8, subagents 6); overflow goes off-floor (roster only),
 * never overlapping. `manuals` are decorative, client-only figures pinned to a
 * specific (zone, slot) — they render on their desk but a real/debug figure that
 * needs that slot takes it over (the manual is reported in `takenOverManualIds`
 * so the caller can drop it). Returns everything the renderer needs. */
export function layoutFloor(figures, selectedId, debugFigures, manuals) {
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

  // Seat manual agents on their pinned slot — unless a real/debug figure already
  // occupies it (takeover) or the slot is invalid/duplicated (dropped silently).
  const manualBySlot = {}; // zone -> { slotIndex: manual }
  const manualSeated = {}; // zone -> [manual] rendered on their desks
  const takenOverManualIds = [];
  ZONES.forEach((z) => { manualBySlot[z.id] = {}; manualSeated[z.id] = []; });
  for (const m of manuals || []) {
    const zone = ZONE_BY_ID[m.zone];
    if (!zone || m.slot == null || m.slot < 0 || m.slot >= zone.slots.length) { takenOverManualIds.push(m.id); continue; }
    if (m.slot < byZone[m.zone].length || manualBySlot[m.zone][m.slot]) { takenOverManualIds.push(m.id); continue; }
    manualBySlot[m.zone][m.slot] = m;
    manualSeated[m.zone].push(m);
  }

  const zonePlates = [], zoneCurbs = [], zoneDepth = [], zoneLabels = [], freeDesks = [], placed = [], nameTags = [];
  ZONES.forEach((zone) => {
    const list = byZone[zone.id];
    const total = all.filter((a) => (ZONE_BY_ID[a.zone] ? a.zone : "coding") === zone.id).length;
    const occupied = list.length + manualSeated[zone.id].length;
    // A zone stays collapsed only when it has NEITHER real nor manual figures —
    // so a placed manual expands its zone and reveals the remaining free desks.
    const collapsed = occupied === 0;
    const stripH = 76;
    const h = collapsed ? stripH : zone.d;
    // Idle zones sit at 60% of an active zone's tint (and depth), so the zones that
    // actually have agents in them pull focus.
    const dim = collapsed ? ZONE_DEPTH.idleOpacity : 1;
    zonePlates.push({ key: zone.id, zone: zone.id, collapsed, x: zone.x, y: zone.y, w: zone.w, h, fill: zone.color, op: 0.055 * dim });
    zoneDepth.push({ key: zone.id, zone: zone.id, collapsed, x: zone.x, y: zone.y, w: zone.w, h, dim });
    zoneCurbs.push({ key: `${zone.id}-l`, x: zone.x, y: zone.y, w: 8, h: collapsed ? stripH : zone.d, fill: zone.color, op: collapsed ? 0.35 : 0.9 });
    zoneCurbs.push({ key: `${zone.id}-b`, x: zone.x, y: zone.y + (collapsed ? stripH - 6 : zone.d - 6), w: zone.w, h: 6, fill: zone.color, op: collapsed ? 0.18 : 0.4 });
    zoneLabels.push({
      // `zone` is what the label is CLICKED with (place a manual agent here), and
      // it was missing — the click passed undefined until the typecheck caught it.
      key: zone.id, zone: zone.id, left: pctX(zone.label[0]), top: pctY(zone.label[1]),
      // Active zone names read at full brightness, idle ones drop back to the dim
      // grey — the zone's own colour still identifies it via the curb and plate.
      accent: collapsed ? "#6B6B7B" : "#C9C9D6", name: zone.name,
      count: collapsed ? `IDLE · 0/${zone.slots.length}` : (total > zone.slots.length ? `${list.length}/${total} · ${total - list.length} off-floor` : `${occupied}/${zone.slots.length}`),
      countColor: total > zone.slots.length ? "#FBBF24" : "#6B6B7B",
      // When empty, one dim line explaining what would put an agent here.
      hint: collapsed ? ZONE_HINT[zone.id] : "",
    });
    if (collapsed) return;
    list.forEach((a, i) => {
      const sl = zone.slots[i];
      placed.push(placeFigure(a.id, colorById[a.id], a.state, sl, selectedId, false, zone.id, i, a.name));
      nameTags.push({ key: `${a.id}-t`, left: pctX(sl[0] + 80), top: pctY(sl[1] - 130), name: a.name, stateColor: STATE_COLOR[a.state] || "#6B6B7B", border: a.state === "awaiting" ? "#FBBF24" : "#2A2A38" });
    });
    // Slots past the real figures: a pinned manual sits there, else a free desk.
    zone.slots.forEach((sl, i) => {
      if (i < list.length) return;
      const m = manualBySlot[zone.id][i];
      if (m) {
        placed.push(placeFigure(m.id, zone.color, m.state || "idle", sl, selectedId, true, zone.id, i, m.name));
        nameTags.push({ key: `${m.id}-t`, left: pctX(sl[0] + 80), top: pctY(sl[1] - 130), name: m.name, stateColor: STATE_COLOR[m.state] || "#6B6B7B", border: m.state === "awaiting" ? "#FBBF24" : "#2A2A38" });
      } else {
        freeDesks.push({ key: `${zone.id}-f${i}`, x: sl[0], y: sl[1], zone: zone.id, slot: i });
      }
    });
  });

  const roster = all.map((a) => {
    const off = offFloor.indexOf(a) !== -1;
    return {
      key: a.id, id: a.id, name: a.name, action: a.action, manual: false,
      accent: off ? "#2A2A38" : (ZONE_BY_ID[a.zone] || ZONE_BY_ID.coding).color,
      color: off ? "#6B6B7B" : colorById[a.id],
      tag: off ? "OFF-FLOOR" : a.state.toUpperCase(),
      stateColor: off ? "#6B6B7B" : (STATE_COLOR[a.state] || "#6B6B7B"),
      bg: a.id === selectedId ? "#1D1D27" : "transparent",
      opacity: off ? 0.6 : 1,
    };
  });
  // Manual agents in WHO IS WORKING: "[name] · manual · <state>".
  for (const zid of Object.keys(manualSeated)) for (const m of manualSeated[zid]) {
    roster.push({
      key: m.id, id: m.id, name: m.name, action: "manual", manual: true,
      accent: ZONE_BY_ID[zid].color, color: STATE_COLOR[m.state] || "#6B6B7B",
      tag: (m.state || "idle").toUpperCase(), stateColor: STATE_COLOR[m.state] || "#6B6B7B",
      bg: m.id === selectedId ? "#1D1D27" : "transparent", opacity: 1,
    });
  }

  return { zonePlates, zoneCurbs, zoneDepth, zoneLabels, freeDesks, placed, nameTags, roster, offFloor, colorById, takenOverManualIds };
}

// --- minimap ----------------------------------------------------------------
// A 120x90 scale model of the 1440x900 floor: one labelled square per zone, dim
// when idle and bright when it holds agents, plus a viewport outline and the
// scroll maths for click-to-centre. Pure so the Node verify covers the geometry.
export const MINIMAP_W = 120;
export const MINIMAP_H = 90;

/** One square per zone, in minimap coordinates, carrying the floor-space centre a
 * click should scroll to. `active` mirrors the zone plate's collapsed flag. */
export function minimapModel(layout) {
  const collapsedBy = {};
  for (const p of (layout && layout.zonePlates) || []) collapsedBy[p.key] = !!p.collapsed;
  return ZONES.map((z) => ({
    key: z.id, zone: z.id,
    label: z.name.slice(0, 2), // "01".."05"
    x: (z.x / 1440) * MINIMAP_W, y: (z.y / 900) * MINIMAP_H,
    w: (z.w / 1440) * MINIMAP_W, h: (z.d / 900) * MINIMAP_H,
    color: z.color, active: !collapsedBy[z.id],
    cx: z.x + z.w / 2, cy: z.y + z.d / 2,
  }));
}

/** The white viewport outline, in minimap coordinates — null when the whole floor
 * already fits (nothing is scrolled out of view, so an outline would be noise). */
export function minimapViewport(scrollLeft, clientWidth, scrollWidth) {
  if (!scrollWidth || !clientWidth || clientWidth >= scrollWidth - 1) return null;
  const w = Math.max(6, (clientWidth / scrollWidth) * MINIMAP_W);
  const x = Math.max(0, Math.min(MINIMAP_W - w, (scrollLeft / scrollWidth) * MINIMAP_W));
  return { x, y: 0, w, h: MINIMAP_H };
}

/** The scrollLeft that puts floor-space x `cxFloor` in the middle of the viewport,
 * clamped to the scrollable range. */
export function centerScrollLeft(cxFloor, clientWidth, scrollWidth) {
  const max = Math.max(0, scrollWidth - clientWidth);
  return Math.max(0, Math.min(max, (cxFloor / 1440) * scrollWidth - clientWidth / 2));
}

/** The context-usage bar across the top of the floor: cumulative session tokens as
 * a percentage of the model's context limit. Green under 50%, amber to 75%, red
 * past it. `known` is false when no limit is available (nothing to show). */
export function tokenBar(tokens, limit) {
  if (!limit || limit <= 0) return { pct: 0, color: "#4ADE80", known: false, label: "" };
  const pct = Math.max(0, Math.min(100, (Number(tokens) || 0) / limit * 100));
  const color = pct > 75 ? "#F87171" : pct >= 50 ? "#FBBF24" : "#4ADE80";
  return { pct, color, known: true, label: `${Math.round(pct)}% CTX` };
}

/** The whole view model: the rail of floors, the active floor's layout + figures,
 * and the global header lines. `debugByFloor[tabId]` are window.domOffice overlays. */
export function sessionsModel(state, activeId, selectedId, debugByFloor, manuals) {
  const order = state.order || [];
  const active = activeId != null && state.agents[activeId] ? activeId : order[0] ?? null;

  const floorTabs = order.map((id, i) => {
    const figs = floorFigures(state, id);
    const working = figs.filter((a) => a.state === "thinking" || a.state === "speaking").length;
    const awaiting = figs.some((a) => a.state === "awaiting");
    const on = id === active;
    const nm = state.agents[id]?.name ?? "";
    return {
      key: id, id, num: String(i + 1).padStart(2, "0"),
      // The rail shows the session NAME (truncated), not a bare number.
      name: nm, label: nm.length > 12 ? nm.slice(0, 11) + "…" : nm,
      bg: on ? "#1D1D27" : "#101017", fg: on ? "#C9C9D6" : "#6B6B7B",
      border: on ? "#6B6B7B" : "#2A2A38", accent: on ? "#22D3EE" : "#2A2A38",
      dot: awaiting ? "#FBBF24" : working ? "#22D3EE" : "#2A2A38",
      dotAnim: working ? { animation: "domTab 1.4s ease-in-out infinite" } : undefined,
    };
  });

  const figs = active != null ? floorFigures(state, active) : [];
  const layout = layoutFloor(figs, selectedId, active != null && debugByFloor ? debugByFloor[active] : [], manuals || []);
  const tab = active != null ? state.agents[active] : null;
  const working = figs.filter((a) => a.state === "thinking" || a.state === "speaking").length;
  const floorAwaiting = figs.filter((a) => a.state === "awaiting").length;
  const awaitingAll = order.reduce((n, id) => n + floorFigures(state, id).filter((a) => a.state === "awaiting").length, 0);
  const totalAgents = order.reduce((n, id) => n + floorFigures(state, id).length, 0);
  const idx = order.indexOf(active);
  // The floor indicators count what is actually SEATED on the floor (real, debug
  // and manual figures alike), so the header can never say "all clear" while an
  // amber badge is visible on a desk. `firstAwaiting` is what "N AWAITING" scrolls to.
  const placedAwaiting = layout.placed.filter((pl) => pl.isAwaiting);
  const placedWorking = layout.placed.filter((pl) => pl.isThinking || pl.isSpeaking).length;
  const firstAwaiting = placedAwaiting[0] || null;

  return {
    floorTabs,
    activeId: active,
    layout,
    awaitingLine: `${awaitingAll}${awaitingAll === 1 ? " AWAITING APPROVAL" : " AWAITING APPROVALS"}`,
    globalLine: `${order.length} SESSIONS · ${totalAgents} AGENTS`,
    // Live session totals for the active tab (per-message cost stays gone).
    costLine: tab ? `${fmtTokens(tab.tokens)} tok · $${(tab.cost || 0).toFixed(4)}` : "",
    // The floor header shows the session NAME (with its position as a dim prefix).
    sessionTitle: tab ? tab.name : "—",
    sessionNum: tab ? String(idx + 1).padStart(2, "0") : "",
    sessionTask: tab ? activityFor(state, active) : "no session",
    sessionAccent: floorAwaiting ? "#FBBF24" : working ? "#22D3EE" : "#2A2A38",
    sessionState: floorAwaiting ? `${floorAwaiting} BLOCKED` : working ? `${working} WORKING` : "PARKED",
    sessionStateColor: floorAwaiting ? "#FBBF24" : working ? "#22D3EE" : "#6B6B7B",
    offFloorLine: layout.offFloor.length ? `${layout.offFloor.length} OFF-FLOOR` : "ALL SEATED",
    offFloorColor: layout.offFloor.length ? "#FBBF24" : "#6B6B7B",
    ctxLine: `${figs.length} agents · ${state.order.length} sessions`,
    chatHeader: tab ? `CHAT · ${tab.name}` : "CHAT",
    // --- floor status indicators ---
    // One dot beside OFFICE FLOOR: green = everyone idle, cyan = someone working,
    // amber = someone blocked on an approval.
    floorDot: placedAwaiting.length ? "#FBBF24" : placedWorking ? "#22D3EE" : "#4ADE80",
    floorDotPulse: !!(placedAwaiting.length || placedWorking),
    // The agent count, swapped for the amber blocked count whenever anything on
    // this floor is waiting on the user.
    floorCount: placedAwaiting.length ? `${placedAwaiting.length} AWAITING` : `${layout.placed.length} AGENTS`,
    floorCountColor: placedAwaiting.length ? "#FBBF24" : "#6B6B7B",
    floorAwaitingCount: placedAwaiting.length,
    firstAwaitingId: firstAwaiting ? firstAwaiting.id : null,
    firstAwaitingX: firstAwaiting ? firstAwaiting.deskX + 60 : null,
    // Context usage for the 2px bar across the top of the floor container.
    tokenBar: tokenBar(tab ? tab.tokens : 0, tab ? tab.contextLimit : 0),
  };
}

// Verify (floor polish + chat hierarchy): the pure model behind the floor/chat UI
// improvements — zone depth shells and idle dimming, per-state/per-variant agent
// treatments, the minimap geometry + click-to-centre scroll maths, the context
// token bar thresholds, the floor status indicators, and the per-kind chat message
// treatments. Imports the SAME modules the browser bundle does.
//
// The SVG/DOM rendering itself needs a live browser and is NOT covered here.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const imp = (f) => import(pathToFileURL(path.resolve(here, f)).href);
const S = await imp("../web/src/sessions.js");
const C = await imp("../web/src/chatgroups.js");
const { ZONES, ZONE_DEPTH, variantOf, layoutFloor, sessionsModel, minimapModel, minimapViewport, centerScrollLeft, tokenBar, MINIMAP_W, MINIMAP_H } = S;

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };
const near = (a, b) => Math.abs(a - b) < 0.001;

// --- 1. zone depth -----------------------------------------------------------
const fig = (id, zone, state) => ({ id, tabId: 1, kind: "tab", name: id, zone, state, action: "", output: [], thinking: [] });
const L = layoutFloor([fig("a", "coding", "thinking"), fig("b", "subagents", "idle")], null, [], []);

ok("every zone gets a depth shell", L.zoneDepth.length === ZONES.length);
ok("depth shell geometry matches its plate", L.zoneDepth.every((d) => {
  const p = L.zonePlates.find((z) => z.key === d.key);
  return p && p.x === d.x && p.y === d.y && p.w === d.w && p.h === d.h;
}));
ok("light top/left and dark bottom/right edges are distinct",
  ZONE_DEPTH.lightEdge === "#2A2A38" && ZONE_DEPTH.darkEdge === "#1a1a22");
ok("the ceiling strip is 3px of #3a3a4a", ZONE_DEPTH.ceiling === 3 && ZONE_DEPTH.ceilingFill === "#3a3a4a");

const codingDepth = L.zoneDepth.find((d) => d.key === "coding");
const planDepth = L.zoneDepth.find((d) => d.key === "planning");
ok("an occupied zone renders its depth at full strength", codingDepth.dim === 1 && codingDepth.collapsed === false);
ok("an idle zone renders at 0.6", planDepth.dim === 0.6 && planDepth.collapsed === true);
const codingPlate = L.zonePlates.find((z) => z.key === "coding");
const planPlate = L.zonePlates.find((z) => z.key === "planning");
ok("an idle zone background tint is 60% of an active one", near(planPlate.op, codingPlate.op * 0.6));

const codingLabel = L.zoneLabels.find((z) => z.key === "coding");
const planLabel = L.zoneLabels.find((z) => z.key === "planning");
ok("the active zone label is full-brightness #C9C9D6", codingLabel.accent === "#C9C9D6");
ok("an idle zone label is dim #6B6B7B", planLabel.accent === "#6B6B7B");

// --- 2. agent visual distinction ---------------------------------------------
ok("cyan is VAR-A", variantOf("#22D3EE") === "A" && variantOf("#5be1f2") === "A");
ok("green is VAR-C", variantOf("#4ADE80") === "C" && variantOf("#86E9AC") === "C");
ok("the purple/indigo family is VAR-B",
  variantOf("#C084FC") === "B" && variantOf("#E879F9") === "B" && variantOf("#818CF8") === "B");

const busy = L.placed.find((p) => p.id === "a"); // coding slot 0 -> #22D3EE -> VAR-A
ok("a working agent scales to 110%", /scale\(1\.100/.test(busy.figTransform));
ok("a working agent gets the soft cyan glow", busy.figFilter === "drop-shadow(0 0 6px #22D3EE88)");
ok("VAR-A gets a monitor glow and no second monitor", busy.deskGlow === true && busy.deskSecondMonitor === false);

const idleSub = L.placed.find((p) => p.id === "b"); // subagents slot 0 -> #C084FC -> VAR-B
ok("an idle agent renders at 90% opacity", idleSub.opacity === 0.9);
ok("an idle agent has no glow and no scale-up", !idleSub.figFilter && !/scale\(1\.100/.test(idleSub.figTransform ?? ""));
ok("VAR-B stands taller (7% on y only)", /scale\(1\.000 1\.070\)/.test(idleSub.figTransform));

const green = layoutFloor([fig("j", "application", "thinking")], null, [], []).placed[0];
ok("VAR-C gets a second monitor and no glow", green.variant === "C" && green.deskSecondMonitor === true && green.deskGlow === false);

// --- 3. chat message hierarchy -----------------------------------------------
const tool = C.messageStyle("tool", false);
ok("tool calls are inset behind a 2px #3A3A4A rule on #15151C at 0.9em",
  tool.variant === "tool" && tool.borderLeft === "2px solid #3A3A4A" && tool.bg === "#15151C" && tool.fontSize === 0.9);
const asst = C.messageStyle("assistant", false);
ok("assistant replies are unboxed, transparent, full size",
  asst.variant === "assistant" && asst.bg === "transparent" && asst.boxed === false && asst.borderLeft === "" && asst.fontSize === 1);
const sys = C.messageStyle("system", false);
ok("system notes are centred dim #6B6B7B captions at 0.85em",
  sys.variant === "system" && sys.centered === true && sys.color === "#6B6B7B" && sys.fontSize === 0.85 && sys.bg === "transparent");
ok("system notes drop the from/time header (they are captions, not messages)", sys.showMeta === false);
const usr = C.messageStyle("user", false);
ok("user turns keep their box and gain a cyan right edge",
  usr.variant === "user" && usr.boxed === true && usr.borderRight === "2px solid #22D3EE33");
const appr = C.messageStyle("assistant", true);
ok("permission prompts get a full-width amber wash",
  appr.variant === "approval" && appr.wrapTint === "#FBBF2422");
ok("approval beats kind — a prompt is never styled as its underlying kind",
  C.messageStyle("user", true).variant === "approval" && C.messageStyle("tool", true).variant === "approval");
ok("the five treatments are all visually distinct",
  new Set([tool, asst, sys, usr, appr].map((x) => JSON.stringify(x))).size === 5);

// --- 4. minimap --------------------------------------------------------------
const cells = minimapModel(L);
ok("the minimap shows every zone", cells.length === ZONES.length);
ok("minimap squares are labelled with the zone number", cells.map((c) => c.label).join(",") === "01,02,04,03,05");
ok("every square fits inside the 120x90 panel",
  cells.every((c) => c.x >= 0 && c.y >= 0 && c.x + c.w <= MINIMAP_W + 0.001 && c.y + c.h <= MINIMAP_H + 0.001));
ok("squares carry the zone accent colour", cells.every((c) => c.color === ZONES.find((z) => z.id === c.zone).color));
ok("occupied zones read active, empty ones idle",
  cells.find((c) => c.zone === "coding").active === true && cells.find((c) => c.zone === "planning").active === false);

ok("no viewport outline while the whole floor fits", minimapViewport(0, 800, 800) === null);
const vp = minimapViewport(300, 600, 1200);
ok("a scrolled floor gets a proportional outline", !!vp && near(vp.w, MINIMAP_W / 2) && near(vp.x, MINIMAP_W / 4) && vp.h === MINIMAP_H);
ok("the outline never leaves the panel", minimapViewport(99999, 600, 1200).x + minimapViewport(99999, 600, 1200).w <= MINIMAP_W + 0.001);

// Click-to-centre: the coding zone centre lands in the middle of the viewport.
const coding = cells.find((c) => c.zone === "coding");
ok("clicking a zone centres it in the viewport",
  near(centerScrollLeft(coding.cx, 600, 1200), (coding.cx / 1440) * 1200 - 300));
ok("centring clamps to the scrollable range",
  centerScrollLeft(0, 600, 1200) === 0 && centerScrollLeft(1440, 600, 1200) === 600);
ok("an unscrollable floor always centres at 0", centerScrollLeft(700, 900, 900) === 0);

// --- 5. floor status indicators ----------------------------------------------
ok("no context limit means no bar to draw", tokenBar(5000, 0).known === false);
ok("under 50% is green", tokenBar(10, 100).color === "#4ADE80" && tokenBar(49, 100).color === "#4ADE80");
ok("50 to 75% is amber", tokenBar(50, 100).color === "#FBBF24" && tokenBar(75, 100).color === "#FBBF24");
ok("above 75% is red", tokenBar(76, 100).color === "#F87171" && tokenBar(99, 100).color === "#F87171");
ok("the bar clamps to 0-100%", tokenBar(500, 100).pct === 100 && tokenBar(-5, 100).pct === 0);
ok("the bar is labelled with a whole percentage", tokenBar(25, 100).label === "25% CTX");

const mk = (id, name, extra) => Object.assign({ id, name, mode: "ask", busy: false, awaitingPermission: false, tokens: 0, cost: 0, contextLimit: 200000 }, extra);
const base = { order: [1], agents: { 1: mk(1, "LEDGER") }, running: {}, actions: {}, jobs: {}, subagents: [], transcripts: {} };
const idleM = sessionsModel(base, 1, null, {}, []);
ok("all idle gives a green floor dot, not pulsing", idleM.floorDot === "#4ADE80" && idleM.floorDotPulse === false);
ok("all idle shows the agent count in the header", idleM.floorCount === "1 AGENTS" && idleM.floorCountColor === "#6B6B7B");
ok("nothing awaiting gives no scroll target", idleM.floorAwaitingCount === 0 && idleM.firstAwaitingId === null);

const busyM = sessionsModel({ ...base, agents: { 1: mk(1, "LEDGER", { busy: true }) } }, 1, null, {}, []);
ok("anyone working gives a cyan pulsing dot", busyM.floorDot === "#22D3EE" && busyM.floorDotPulse === true);

const waitM = sessionsModel({ ...base, agents: { 1: mk(1, "LEDGER", { awaitingPermission: true, busy: true }) } }, 1, null, {}, []);
ok("anyone blocked gives an amber dot", waitM.floorDot === "#FBBF24");
ok("anyone blocked shows N AWAITING in amber instead of the agent count",
  waitM.floorCount === "1 AWAITING" && waitM.floorCountColor === "#FBBF24" && waitM.floorAwaitingCount === 1);
ok("N AWAITING knows which agent to scroll to",
  waitM.firstAwaitingId === "tab:1" && typeof waitM.firstAwaitingX === "number");

const usedM = sessionsModel({ ...base, agents: { 1: mk(1, "LEDGER", { tokens: 160000 }) } }, 1, null, {}, []);
ok("the model carries live context usage for the bar",
  usedM.tokenBar.known === true && usedM.tokenBar.pct === 80 && usedM.tokenBar.color === "#F87171");
ok("a session with no known context limit reports no bar",
  sessionsModel({ ...base, agents: { 1: mk(1, "LEDGER", { contextLimit: 0 }) } }, 1, null, {}, []).tokenBar.known === false);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);

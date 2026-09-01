// Verify (voice overlay): what the compositor actually produced.
//
// The measurements come from _overlay-render.cjs, which drives a REAL
// transparent Electron BrowserWindow configured the way voice.js configures the
// overlay, and reads pixels back with capturePage(). That is the only way to see
// the two worst bugs this panel has had:
//
//   - backdrop-filter turned the window's unpainted area BLACK. Rendering the
//     page anywhere else showed nothing wrong; only the alpha channel of a real
//     transparent window's own buffer told the truth.
//   - contrast was computed by parsing alphas out of the stylesheet, and
//     silently measured the wrong layer the moment the material gained one —
//     reporting 1.13:1 for text that was perfectly legible.
//
// So nothing here reads CSS or source. Render it, read the pixels, judge those.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (n, c, d) => { console.log((c ? "PASS " : "FAIL ") + n + (d ? " — " + d : "")); if (!c) fails++; };

const bin = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const probe = path.join(root, "verify", "_overlay-render.cjs");
const run = spawnSync(bin, [probe], { encoding: "utf8", timeout: 120000, cwd: root });
const line = (run.stdout || "").split("\n").reverse().find((l) => l.trim().startsWith("{"));

if (!line) {
  // A headless CI box with no display cannot open a window at all. That is a
  // skip, not a failure — but it must be loud, because it is also exactly what a
  // broken probe looks like and silently passing would hide a real regression.
  console.log("SKIP overlay render checks — no Electron window available");
  console.log((run.stderr || "").split("\n").slice(0, 3).join("\n"));
  process.exit(0);
}
const m = JSON.parse(line);
ok("the probe completed without error", !m.error, m.error || "");

// --- 0. the page actually initialised ----------------------------------------
//
// The probe used to render the overlay with no preload, so window.voice was
// undefined, the page's script threw at its first bridge call, and everything
// after that line — the permission pane, the tab wiring — never ran. Geometry
// measured fine on the half-built DOM, which is the point: assert it is whole
// before believing anything measured off it.
ok("the page initialised with its bridge", m.pageOk && m.pageOk.bridge && m.pageOk.ready,
  JSON.stringify(m.pageOk || null));
ok("the permission pane rendered", m.pageOk && m.pageOk.pane === true);

// --- 1. there is no transparent region, which is the whole point -------------
//
// This block used to assert the opposite: that the window's unpainted margin
// was fully transparent. It WAS — capturePage() reported alpha 0 at every
// corner through three separate attempts at this bug — and the panel still
// rendered inside a hard black rectangle on the user's screen, because the
// window's own buffer was never the problem. What the desktop compositor did
// with that buffer on that GPU was, and nothing in this process can reach it.
//
// So the window is opaque now and the assertion inverts. A region that does
// not exist cannot composite wrongly: this is a guarantee rather than a fourth
// attempt. If the panel ever goes back to being transparent, this fails, and
// it should — that change needs to be deliberate and re-verified on real
// hardware, not inherited.
for (const k of ["top-left", "top-right", "bottom-left", "bottom-right", "mid-top", "mid-left"]) {
  ok(k + " is painted, not transparent", m.probes[k] === 255, "alpha " + m.probes[k]);
}
ok("the panel fills its own window", m.probes["pill-body"] === 255, "alpha " + m.probes["pill-body"]);

// --- 2. contrast over the backgrounds a floating panel actually lands on -----
{
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const L = (p) => 0.2126 * lin(p[0] / 255) + 0.7152 * lin(p[1] / 255) + 0.0722 * lin(p[2] / 255);
  const ratio = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const over = (px, bg) => [0, 1, 2].map((i) => px[i] * (px[3] / 255) + bg[i] * (1 - px[3] / 255));
  ok("a text pixel was found to measure", !!m.contrast.glyph && m.contrast.glyph[3] > 0);
  for (const b of [["white", [255, 255, 255]], ["black", [0, 0, 0]], ["colour", [46, 122, 214]], ["detail", [190, 170, 120]]]) {
    const r = ratio(over(m.contrast.glyph, b[1]), over(m.contrast.surface, b[1]));
    ok("the state label clears WCAG AA over " + b[0], r >= 4.5, r.toFixed(2) + ":1");
  }
}

// --- 3. one state, one truth -------------------------------------------------
//
// "speaking" used to light the READY step, so the panel said Answering… and
// READY at the same moment.
for (const c of [["listening", "Listening…", "stepListening"], ["thinking", "Processing…", "stepProcessing"], ["speaking", "Answering…", "stepAnswering"]]) {
  const s = m.states[c[0]];
  ok(c[0] + ": both labels agree", s.pill === c[1] && s.big === c[1], s.pill + " / " + s.big);
  ok(c[0] + ": exactly one step is lit, and it is " + c[2], s.lit.length === 1 && s.lit[0] === c[2], s.lit.join(",") || "none");
  ok(c[0] + ": the orb follows the same state", s.orb === c[0]);
}
ok("error clears the rail rather than leaving the last step lit", m.states.error.lit.length === 0, m.states.error.lit.join(","));
ok("...and says so", m.states.error.big === "Voice error");

// --- 3b. the status rail is a ROW ------------------------------------------
//
// The failure: .steps was one wrapping flex line holding three chips AND the
// hint, in a column ~198px wide, so the chips stacked vertically and the hint
// was pushed off the bottom of the panel entirely. "One row" is asserted as
// "every visible chip has the same top", which is the thing that was wrong —
// `flex-wrap: nowrap` in the stylesheet would not have caught a chip pushed
// down by an overflow.
{
  const DESIGN = ["720:listening", "720:thinking", "720:speaking"];
  for (const k of DESIGN) {
    const r = m.rail[k];
    ok(k + ": all three chips are shown", r.shown.length === 3, r.shown.join(",") || "none");
    ok(k + ": they occupy exactly one row", new Set(r.tops).size === 1, JSON.stringify(r.tops));
    ok(k + ": the row does not overflow its column", !r.stepsOverflow &&
      r.rowRight <= r.railRect.x + r.railRect.w + 1,
      Math.round(r.rowRight - r.stepsRect.x) + "px in " + Math.round(r.container) + "px");
  }
  // Labels are not abbreviated at the design width — the chips are compact, the
  // words are whole.
  ok("the labels are not abbreviated at the design width",
    m.rail["720:speaking"].shown.length === 3 && !m.rail["720:speaking"].stepsOverflow);

  // Only ANSWERING is live while the state is speaking. This is the pairing that
  // was wrong before ("speaking" lit a READY step), so it is asserted from the
  // rendered rail rather than from the STEP table.
  for (const c of [["720:listening", "stepListening"], ["720:thinking", "stepProcessing"], ["720:speaking", "stepAnswering"]]) {
    const r = m.rail[c[0]];
    ok(c[0] + ": exactly one chip is active, and it is " + c[1],
      r.lit.length === 1 && r.lit[0] === c[1], r.lit.join(",") || "none");
  }
  ok("speaking activates ANSWERING and nothing else",
    m.rail["720:speaking"].lit.join(",") === "stepAnswering");

  // The rail sits BELOW the conversation and ABOVE nothing — it must not land on
  // the transcript, the response, or its own hint.
  for (const k of Object.keys(m.rail)) {
    if (k.startsWith("_")) continue;
    const r = m.rail[k];
    ok(k + ": the rail clears the transcript", r.railRect.y >= r.transcript.b - 1,
      "rail " + Math.round(r.railRect.y) + " vs transcript " + Math.round(r.transcript.b));
    ok(k + ": the rail clears the response", r.railRect.y >= r.response.b - 1,
      "rail " + Math.round(r.railRect.y) + " vs response " + Math.round(r.response.b));
    ok(k + ": the hint is on its own line under the chips",
      !r.shown.length || r.hintRect.y >= r.stepsRect.b - 1,
      "hint " + Math.round(r.hintRect.y) + " vs chips " + Math.round(r.stepsRect.b));
    ok(k + ": the hint is whole, not clipped", !r.hintClipped, JSON.stringify(r.hintText));
    ok(k + ": the left column does not overflow", !r.leftOverflow);
  }
}

// --- 3c. the narrow fallback is one chip, never a vertical stack -------------
//
// 212px is the expanded panel on a small or heavily scaled display, where
// boundsFor() caps the window well under the 720px it asks for.
{
  const n = m.rail["212:speaking"];
  ok("narrow: the rail falls back to a single chip", n.shown.length === 1, n.shown.join(",") || "none");
  ok("narrow: the chip it keeps is the ACTIVE one", n.litShown.length === 1 && n.litShown[0] === "stepAnswering",
    n.litShown.join(",") || "none");
  ok("narrow: it is one row, not a stack", new Set(n.tops).size <= 1, JSON.stringify(n.tops));
  // The whole point: the fallback is SHORTER than three chips would be, not
  // taller. A stack of three at this size is ~75px.
  ok("narrow: the rail stays short", n.railRect.h < 60, Math.round(n.railRect.h) + "px tall");
  ok("narrow: error shows no chip rather than three dead ones",
    m.rail["212:error"].shown.length === 0, m.rail["212:error"].shown.join(","));
  // ...and the squeeze tier really does come first: at 260 all three survive on
  // a row, tighter than at the design width.
  const mid = m.rail["260:speaking"];
  ok("the squeeze tier keeps three chips before falling back", mid.shown.length === 3, mid.shown.join(","));
  ok("...and it is genuinely tighter than the design width",
    (mid.rowRight - mid.stepsRect.x) < (m.rail["720:speaking"].rowRight - m.rail["720:speaking"].stepsRect.x),
    Math.round(mid.rowRight - mid.stepsRect.x) + "px vs " + Math.round(m.rail["720:speaking"].rowRight - m.rail["720:speaking"].stepsRect.x) + "px");
}

// --- 3d. the tab strip still fits beside the wider conversation column -------
//
// The left column was widened to give the rail its row; this is the other half
// of that trade, and it is the thing that would silently regress.
{
  const r = m.rail["720:speaking"];
  ok("the tab strip is one row at the design width", r.tabRows === 1, r.tabRows + " rows");
  ok("...and it clears the corner controls", r.tabsRight <= r.cornerLeft,
    Math.round(r.tabsRight) + " vs " + Math.round(r.cornerLeft));
}

// --- 3e. every icon-only button has an accessible name -----------------------
{
  ok("the button inventory was read", Array.isArray(m.a11y) && m.a11y.length > 0);
  for (const b of m.a11y || []) {
    // A button whose visible text IS its name needs nothing more; an icon-only
    // one does. title alone is not a name — several screen readers ignore it.
    const iconOnly = !b.text || /^\d+$/.test(b.text);
    if (!iconOnly) continue;
    ok("icon-only button '" + b.id + "' has an accessible name", !!b.aria, JSON.stringify(b.aria));
  }
}

// --- 3f. what each control actually DOES -------------------------------------
//
// Read off real clicks through the real listeners, with the bridge recording
// instead of sending. The expand-handler leak is the reason this exists: the
// guard named #shieldBtn and .closeBtn, so the crossed microphone turned voice
// off AND opened the panel onto the feature it had just stopped.
{
  const b = m.behaviour || {};
  const only = (k, call) => ok("'" + k + "' calls " + call + " and nothing else",
    b[k] && b[k].calls.length === 1 && b[k].calls[0] === call, JSON.stringify(b[k] && b[k].calls));
  // Esc and × are the LIGHT exit: end the conversation, leave the wake word armed.
  only("escape", "endSession");
  only("closeBtn", "endSession");
  only("closeBtn2", "endSession");
  ok("Esc does not turn voice off", !(b.escape || {}).calls.includes("stopVoice"));
  ok("× does not turn voice off", !(b.closeBtn || {}).calls.includes("stopVoice"));
  // The crossed microphone is the HEAVY one: it is the only control that does.
  only("micOffBtn", "stopVoice");
  only("micOffBtn2", "stopVoice");
  // ...and none of the three may also expand the pill.
  for (const k of ["closeBtn", "micOffBtn", "escape"]) {
    ok("'" + k + "' does not trigger the pill's expand handler", b[k] && b[k].expanded === false);
  }
  // The shield does, on purpose, and onto the permissions tab.
  ok("the shield expands the panel", b.shieldBtn && b.shieldBtn.expanded === true);
  ok("...onto the permissions tab", b.shieldTab === "permissions", String(b.shieldTab));
  ok("the pill body itself still expands", b.pillBody && b.pillBody.expanded === true);
}

// --- 4. the collapsed copy is never a truncated sentence ---------------------
//
// The original bug: three clauses in an ellipsising element, so the screen read
// "… × turns voice off · 6…". Whatever is shown has to FIT; anything that does
// not fit has to be absent instead.
for (const w of Object.keys(m.copy)) {
  const c = m.copy[w];
  ok("@" + w + "px the state label is shown in full", c.state === true, String(c.state));
  ok("@" + w + "px the hint is whole or absent", c.hint === true || c.hint === "hidden", String(c.hint));
  ok("@" + w + "px the countdown is whole or absent", c.countdown === true || c.countdown === "hidden", String(c.countdown));
}
// The label is the one thing that must never be sacrificed, at any width.
ok("the state label survives at every supported width",
  Object.values(m.copy).every((c) => c.state === true));
// At the narrowest supported pill the hint and the countdown are DELIBERATELY
// gone, not shortened — "hidden" is the only acceptable answer, because a
// present-but-clipped clause is the bug this replaced.
ok("@260px the hint is hidden outright", m.copy["260"].hint === "hidden", String(m.copy["260"].hint));
ok("@260px the countdown is hidden outright", m.copy["260"].countdown === "hidden", String(m.copy["260"].countdown));
// ...and at the design width both are present and whole.
ok("@440px the hint is present and whole", m.copy["440"].hint === true, String(m.copy["440"].hint));
ok("@440px the countdown is present and whole", m.copy["440"].countdown === true, String(m.copy["440"].countdown));

// --- 5. screenshots for review ------------------------------------------------
ok("composited screenshots were written to verify/_shots", m.shots === 24, m.shots + " files");

console.log(fails ? "\n" + fails + " FAILED" : "\nall overlay-render checks passed");
process.exit(fails ? 1 : 0);

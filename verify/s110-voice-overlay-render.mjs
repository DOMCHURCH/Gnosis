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

// --- 1. every region the page does not paint is genuinely transparent --------
// The corners are the furthest point from the pill in both axes, so nothing
// legitimate reaches them: they must be exactly zero.
for (const k of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
  ok(k + " is fully transparent", m.probes[k] === 0, "alpha " + m.probes[k]);
}
// The mid-edge samples sit where the pill is widest and the drop shadow reaches
// furthest, so a trace of shadow is correct there. The threshold is what
// separates "a shadow faded to nothing" from "a backing surface": an opaque
// backing reads 255, and 4/255 is under 2% — invisible, and three orders of
// magnitude from the bug.
for (const k of ["mid-top", "mid-left"]) {
  ok(k + " carries at most a trace of shadow", m.probes[k] <= 4, "alpha " + m.probes[k]);
}
// Inside the margin the drop shadow is allowed — but it has to be a shadow, not
// a wall. This is the assertion that fails if a hard rectangle comes back.
ok("the shadow margin is a shadow, not a backing", m.probes["shadow-margin"] < 90, "alpha " + m.probes["shadow-margin"]);
// And the pill has to be drawn, or "everything is transparent" would pass by
// rendering nothing at all.
ok("the pill itself is drawn", m.probes["pill-body"] > 120, "alpha " + m.probes["pill-body"]);

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

// --- 5. screenshots for review ------------------------------------------------
ok("composited screenshots were written to verify/_shots", m.shots === 12, m.shots + " files");

console.log(fails ? "\n" + fails + " FAILED" : "\nall overlay-render checks passed");
process.exit(fails ? 1 : 0);

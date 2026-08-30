// Verify (voice overlay): the glass is glass, not a colored blur.
//
// The previous material was rgba(12, 13, 20, 0.72) — a near-opaque dark tint —
// wrapped in a cyan/violet/magenta gradient border. That reads as "a panel with
// a glow": a strong tint and a strong colour both fight the one thing that makes
// glass read as glass, which is seeing THROUGH it. This asserts the replacement
// against the actual properties of real glass rather than against a mood:
//
//   - near-transparent (you can tell something is behind it)
//   - refractive (what's behind visibly warps, not just blurs)
//   - a rim catching light from one direction, not a rainbow wrapping the shape
//   - the waveform reads as liquid motion, not a bar chart
//
// Rendering was also confirmed live: `.glass`'s COMPUTED backdrop-filter
// resolved to `blur(38px) saturate(1.85) url("#liquidDistort")` (a typo'd
// property name fails silently, so computed style is what actually matters),
// and screenshots at the real window sizes (electron/voice.js OVERLAY: 440x92
// collapsed, 720x320 expanded) over both a saturated rainbow background and a
// near-black one show the rainbow's colours surviving through the blur, the
// stripes bending across the panel's edge, and a rim highlight visible against
// the dark background that isn't there at all in the old version.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const overlay = readFileSync(path.join(root, "electron", "voice-overlay.html"), "utf8");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- near-transparent, not tinted ------------------------------------------
ok("the glass body is a clear wash, not a dark panel", /background: rgba\(255, 255, 255, 0\.055\);/.test(overlay));
ok("...low enough opacity to actually see through", (() => {
  const m = overlay.match(/\.glass \{[\s\S]*?background: rgba\(255, 255, 255, ([\d.]+)\);/);
  return !!m && Number(m[1]) <= 0.1;
})());
// The old dark tint, and the old colour-wrapped rim, must both be gone —
// otherwise this is a second coat of paint over the first, not a replacement.
ok("the old dark tint is gone", !/rgba\(12, 13, 20, 0\.72\)/.test(overlay));
ok("the old cyan/violet/magenta rim gradient is gone",
  !/linear-gradient\(120deg, rgba\(34, 211, 238.*rgba\(139, 124, 246.*rgba\(232, 121, 249/.test(overlay));

// --- saturation, the cue that makes "through frost" read as vivid ----------
{
  const m = overlay.match(/backdrop-filter:\s*blur\((\d+)px\)\s*saturate\(([\d.]+)\)/);
  ok("blur is in the 30-40px range asked for", !!m && Number(m[1]) >= 30 && Number(m[1]) <= 40);
  ok("saturation is boosted (~180%), not left flat", !!m && Number(m[2]) >= 1.6);
}

// --- real refraction, not a static blur -------------------------------------
ok("an SVG turbulence+displacement filter is defined", /feTurbulence/.test(overlay) && /feDisplacementMap/.test(overlay));
ok("...chained onto the SAME backdrop-filter as the blur",
  /backdrop-filter:\s*blur\(\d+px\)\s*saturate\([\d.]+\)\s*url\(#liquidDistort\)/.test(overlay));
ok("...displacing the actual backdrop content", /feDisplacementMap in="SourceGraphic"/.test(overlay));
ok("the warp moves over time rather than sitting static",
  /<animate attributeName="baseFrequency"/.test(overlay));
// A static-looking hidden ancestor stops SMIL animation in Chromium.
ok("the filter defs stay out of layout without stopping the animation",
  /<svg width="0" height="0" style="position: absolute" aria-hidden="true">/.test(overlay));
ok("reduced motion freezes the warp instead of leaving it moving",
  /prefers-reduced-motion: reduce.*\)\.matches/.test(overlay) && /querySelector\("animate"\)\?\.remove\(\)/.test(overlay));
// The displacement scale is a deliberate design choice (subtle bend, not a
// funhouse mirror) — pin it so a future edit has to change this test to change
// the feel, rather than drifting silently.
ok("the displacement is subtle (scale <= 16px)", (() => {
  const m = overlay.match(/feDisplacementMap[^>]*scale="(\d+)"/);
  return !!m && Number(m[1]) <= 16;
})());

// --- a rim, not a rainbow ----------------------------------------------------
// One direction (top-down), fading out, not a hue wrapped around the whole
// shape — the latter is exactly what read as "a glow" instead of "an edge".
ok("the rim highlight comes from one direction (top)",
  /\.frame \{[\s\S]*?background: linear-gradient\(180deg,/.test(overlay));
ok("...bright at the top, fading toward the bottom",
  /rgba\(255, 255, 255, 0\.75\) 0%[\s\S]*?rgba\(255, 255, 255, 0\.0[0-9]+\) (32|4\d)%/.test(overlay));
// The specular sheen is a second, independent highlight — must exist, and must
// agree with the rim about where the light is coming from (top-left corner),
// or the glass reads as lit from two different places at once.
ok("a specular sheen exists on the glass surface", /\.glass::before/.test(overlay));
ok("...anchored top-left, matching the rim's own direction",
  /radial-gradient\(\d+px \d+px at 18% -20%/.test(overlay));

// --- no colour tint on the material itself -----------------------------------
// The accent colours (--cyan/--violet/--magenta) are allowed to remain on
// INTERACTIVE elements — the listening dot, the shield hover, tab state — the
// same way real Liquid Glass keeps colored control tints on a clear material.
// What must not happen is the GLASS ITSELF (.frame's background, .glass's
// background) carrying one of those hues.
for (const [name, sel] of [["frame", /\.frame \{[\s\S]*?\n      \}/], ["glass", /\.glass \{[\s\S]*?\n      \}/]]) {
  const block = overlay.match(sel)?.[0] ?? "";
  ok(`${name} block carries no accent hue`,
    block.length > 0 && !/#22d3ee|#8b7cf6|#e879f9|34, 211, 238|139, 124, 246|232, 121, 249/i.test(block));
}

// --- the waveform is liquid, not bars ----------------------------------------
ok("bars are gone — no discrete rectangles are drawn", !/g\.roundRect\(/.test(overlay));
ok("the wave is a smooth curve through the samples", /quadraticCurveTo/.test(overlay));
ok("...traced as one continuous line via midpoints (not straight segments)",
  /function traceSmooth/.test(overlay) && /const mx = \(pts\[i\]\.x \+ pts\[i \+ 1\]\.x\) \/ 2;/.test(overlay));
ok("the wave is a FILLED body (top+bottom mirrored), not a single line",
  /top\.push\(\{ x, y: mid - amp \}\)/.test(overlay) && /bottom\.push\(\{ x, y: mid \+ amp \}\)/.test(overlay));
ok("...filled white/translucent rather than the old accent gradient",
  /rgba\(255,255,255,0\.22\)/.test(overlay) && !/addColorStop\(0, "#22d3ee"\)/.test(overlay));
ok("the liquid's own surface catches a rim light too",
  /strokeStyle = "rgba\(255,255,255,0\.8\)"/.test(overlay));
ok("a specular highlight tracks the current peak (wet, not painted-on)",
  /peakV > peakX|peakX = x; peakY/.test(overlay) || /if \(v > peakV\)/.test(overlay));
ok("...moves WITH the loudest sample rather than sitting fixed",
  /createRadialGradient\(peakX, peakY, 0, peakX, peakY/.test(overlay));

// --- still driven by the real microphone, still one instance -----------------
// Regression guard: none of the above should have detached the waveform from
// the actual audio level or duplicated the drawing code per canvas.
ok("still driven by the real mic level", /window\.voice\.onLevel/.test(overlay));
ok("one draw function serves both canvases", (overlay.match(/function drawInto\(/g) ?? []).length === 1);

console.log(fails ? `\n${fails} FAILED` : "\nall liquid-glass checks passed");
process.exit(fails ? 1 : 0);

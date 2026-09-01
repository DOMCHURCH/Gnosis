// Verify (voice overlay): the glass is glass, not a grey blob.
//
// This suite has been through two designs, and the history is the point.
//
// The FIRST material was rgba(12,13,20,0.72) — a near-opaque dark tint wrapped
// in a cyan/violet/magenta gradient border. That read as "a panel with a glow".
// It was replaced by a near-transparent wash under a 38px blur with an animated
// SVG feTurbulence/feDisplacementMap chained onto backdrop-filter.
//
// That second version is what this suite used to pin, and it was ALSO wrong, in
// a way the assertions could not see because they checked for the mechanism
// rather than the result. Two reasons (VOICE-UI-ISSUES.md #1):
//
//   - 38px of blur destroys the information the effect is made of. Past roughly
//     20px a backdrop averages to its own mean colour, and the mean of anything
//     is grey. saturate() cannot restore detail that has already been averaged
//     away, so the panel read as a washed grey blob no matter how vivid the
//     desktop behind it was. The refraction was invisible for the same reason:
//     there was nothing left with an edge to bend.
//   - The fill was 5.5% white and the shadow was pure black — nothing to catch
//     light, and a shadow that drains colour from everything it touches.
//
// So the checks below now pin the RESULT the user asked for — the standard
// frosted-glass recipe — rather than a particular filter graph:
//
//   - a moderate blur that leaves the backdrop legible
//   - a low-opacity fill, a 1px lit edge, and a COLOURED lift shadow
//   - a rim catching light from one direction, not a hue wrapped round the shape
//   - text that clears WCAG AA over the worst backdrop (a white desktop)
//   - the waveform reads as liquid motion, not a bar chart
//
// The animated displacement filter is deliberately GONE, and there is an
// assertion below that it stays gone: it re-evaluated a turbulence filter over
// the whole backdrop every frame on a window that floats permanently above real
// work, which is the compositor cost this project has repeatedly chosen not to
// pay for an effect nobody could see.
//
// Rendering and geometry are checked for real, in a browser, by
// s90-voice-overlay.mjs. This suite is the static half: it pins the intent in
// the stylesheet so a future edit has to argue with the comments above.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const overlay = readFileSync(path.join(root, "electron", "voice-overlay.html"), "utf8");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- translucent, but with something there to catch light -------------------
// A fill this low used to be 0.055, which is close enough to nothing that the
// rim light had no surface to sit on. The band is two-sided on purpose: too high
// and it is a painted panel again.
// The material is tokenised now: --base is the charcoal-navy the scrim is made
// of and --scrim is how much of the backdrop it covers, so the assertions pin
// the tokens rather than one literal rgba() that a retune would rewrite.
//
// Pinned as a RANGE rather than one literal. It was `includes("...0.055)")`, which
// meant a polish pass that moved the fill from 0.055 to 0.06 failed a test whose
// stated intent ("low-opacity wash, not a dark panel") it had not violated. The
// band is what the assertion was always about; the exact number is a tuning knob.
{
  // Parsed by hand rather than by regex. electron/ is CRLF, and the pattern
  // this replaces anchored on a bare newline after the semicolon — so it
  // extracted NaN and failed as though the material had changed, when only the
  // line endings differed. A string scan does not care.
  const gi = overlay.indexOf(".glass {");
  const bgAt = gi === -1 ? -1 : overlay.indexOf("background:", gi);
  // Bounded to the background declaration: the box-shadow below it also carries
  // an rgba(255,255,255,...) and is a different thing entirely.
  const decl = bgAt === -1 ? "" : overlay.slice(bgAt, overlay.indexOf(";", bgAt));
  const key = "rgba(255, 255, 255, ";
  const k = decl.lastIndexOf(key);
  const a = k === -1 ? NaN : parseFloat(decl.slice(k + key.length));
  ok("the glass body is a low-opacity wash, not a dark panel", a >= 0.03 && a <= 0.12, "fill alpha " + a);
}
ok("...with the contrast scrim folded into the same background", overlay.includes("rgba(var(--base), var(--scrim))"));
// The pseudo-element it replaced must not come back: it is what forced a
// z-index onto the content and broke the buttons on Windows.
ok("...and not as a ::after over the content", !overlay.includes(".glass::after"));
// The scrim has to stay heavy: with no brightness() clamp on the backdrop it
// is the entire contrast guarantee. s110 measures the ratios it produces from
// real pixels over four backgrounds; this pins the input so a retune for looks
// cannot quietly drop it.
ok("the scrim is heavy enough to carry the contrast alone", (() => {
  const m = /--scrim: ([0-9.]+);/.exec(overlay);
  return !!m && Number(m[1]) >= 0.65;
})());
ok("...with a 1px lit edge along the inside of the lip", overlay.includes("inset 0 1px 0 0 var(--inner-rim)"));
// The old dark tint, and the old colour-wrapped rim, must both be gone —
// otherwise this is a second coat of paint over the first, not a replacement.
ok("the old dark tint is gone", !/rgba\(12, 13, 20, 0\.72\)/.test(overlay));
ok("the old cyan/violet/magenta rim gradient is gone",
  !/linear-gradient\(120deg, rgba\(34, 211, 238.*rgba\(139, 124, 246.*rgba\(232, 121, 249/.test(overlay));

// --- no backdrop-filter, and that is the point ------------------------------
//
// This suite used to require blur + saturate + brightness on .glass, and the
// brightness clamp was the contrast guarantee. All of it is gone, because in a
// TRANSPARENT window backdrop-filter has no backdrop to sample: Chromium gives
// the window an opaque backing to filter instead, and every part of the window
// the page has not painted over turns black. That was the dark rectangle around
// the pill — it grew when the window grew, which a clipped shadow could not do.
//
// It was never doing the job it was credited with either. It could only have
// blurred content inside this same window, and there is none behind the glass.
ok("no backdrop-filter anywhere in the overlay", !overlay.includes("backdrop-filter:"));
// The material is layered translucency over a rim instead: a dark scrim and a
// white fill in one background, so neither needs a pseudo-element or a
// stacking context (see the note in the stylesheet).
ok("the glass is layered translucency instead",
  overlay.includes("rgba(var(--base), var(--scrim))") && /\.glass \{[\s\S]*?rgba\(255, 255, 255, 0\.\d+\);/.test(overlay));
// And the scrim is now the whole contrast guarantee, so it has to stay heavy.
// s90 computes the actual ratios against a white desktop; this only pins the
// input, because a lighter scrim is the tempting change and the silent one.
// (covered above, against the token rather than a literal)

// --- the animated displacement filter is gone, and stays gone ---------------
// Not a regression: a deliberate removal. See the header. Pinned so it cannot
// creep back in the next time someone wants the panel to look livelier.
// Matched as ELEMENTS, not as bare words: the stylesheet's comment explains why
// the filter was removed and names it doing so, and a comment saying "this is
// gone" must not read as evidence that it is still here.
ok("no SVG turbulence/displacement filter remains",
  !/<feTurbulence/.test(overlay) && !/<feDisplacementMap/.test(overlay) && !/<filter\b/.test(overlay));
// (The old "backdrop-filter references no SVG filter" check lived here. It
// required at least one backdrop-filter declaration to exist so it could
// assert none of them used url(). There are none at all now — asserted above
// — so it had nothing left to guard.)
ok("the now-orphaned filter id is gone too", !/liquidDistort/.test(overlay));

// --- the shadow lifts the surface, and is coloured --------------------------
// A pure-black shadow drains colour from everything it touches and reads as the
// panel being stamped into the page rather than floating above it.
ok("the lift shadow is coloured, not black", /0 6px 20px -4px rgba\(31, 38, 135, 0\.\d+\)/.test(overlay));
/*
 * And it is entirely contained by the transparent margin.
 *
 * This is the assertion the black-rectangle bug actually needed and never had:
 * a shadow reaches offset + blur/2 + spread from its element, and a shadow that
 * reaches further than --shadow-pad is clipped at the window edge — which is a
 * rectangle. Computed from the stylesheet rather than asserted as a comment, so
 * adding a fourth stop cannot quietly re-open it.
 */
{
  const pad = Number(overlay.match(/--shadow-pad: (\d+)px/)?.[1] ?? NaN);
  const frame = overlay.match(/\.frame \{[\s\S]*?\n {8}box-shadow:([\s\S]*?);/)?.[1] ?? "";
  // Split on commas that are NOT inside an rgba(), or every colour becomes three
  // bogus "stops" — which is what the first version of this check did, and it
  // then failed every stop by parsing "0 0 22px -8px rgba(34" as two lengths.
  const stops = frame.replace(/rgba?\([^)]*\)/g, "COLOR")
    .split(",").map((t) => t.trim()).filter(Boolean);
  ok("--shadow-pad is a number the shadow can be checked against", pad > 0, String(pad));
  ok("the frame casts at least one shadow", stops.length > 0, stops.length + " stops");
  for (const stop of stops) {
    // Lengths only, and a bare `0` is a length: `0 0 22px -8px` is four of them.
    const n = (stop.replace("COLOR", "").trim().match(/-?\d*\.?\d+(?:px)?/g) || []).map(parseFloat);   // Number("22px") is NaN; parseFloat is not
    // [offsetX, offsetY, blur, spread] — spread is optional and defaults to 0.
    const [ox = 0, oy = 0, blur = 0, spread = 0] = n;
    const reach = Math.max(Math.abs(ox), Math.abs(oy)) + blur / 2 + spread;
    ok("shadow stop fits inside the transparent margin: " + stop.replace(/\s+/g, " "),
      reach <= pad, Math.round(reach) + "px of " + pad + "px");
  }
}

// --- a rim, not a rainbow ----------------------------------------------------
// One direction (top-down), fading out, not a hue wrapped around the whole
// shape — the latter is exactly what read as "a glow" instead of "an edge".
ok("the rim highlight comes from one direction (top)",
  /\.frame \{[\s\S]*?background: linear-gradient\(180deg,/.test(overlay));
ok("...bright at the top, fading toward the bottom", overlay.includes("var(--rim-top) 0%") && overlay.includes("var(--rim-side) 34%"));
// The specular sheen is a second, independent highlight — must exist, and must
// agree with the rim about where the light is coming from (top-left corner),
// or the glass reads as lit from two different places at once.
ok("a specular sheen exists on the glass surface", /\.glass::before/.test(overlay));
ok("...anchored top-left, matching the rim's own direction", overlay.includes("at 20% -24%"));

// --- no colour tint on the material itself -----------------------------------
// The accent colours (--cyan/--violet/--magenta) are allowed to remain on
// INTERACTIVE elements — the listening dot, the shield hover, tab state — the
// same way real Liquid Glass keeps colored control tints on a clear material.
// What must not happen is the GLASS ITSELF (.frame's background, .glass's
// background) carrying one of those hues.
//
// Re-pointed, deliberately. This used to BAN the accent hues from .frame and
// .glass outright. The overlay now carries an environmental reflection — a cyan
// separation halo on .frame and a cyan/violet cast inside .glass — which was
// asked for and which is the difference between glass sitting in a room and a
// grey card. So the rule is no longer "no hue", it is "no hue you could name":
// every accent alpha on the material itself stays under 0.35, and the opaque
// hex forms stay banned entirely, because those are what make it a tinted panel.
for (const [name, sel] of [["frame", /\.frame \{[\s\S]*?\n      \}/], ["glass", /\.glass \{[\s\S]*?\n      \}/]]) {
  const block = overlay.match(sel)?.[0] ?? "";
  ok(`${name} block exists to check`, block.length > 0);
  ok(`${name} block uses no solid accent colour`,
    !/#22d3ee|#8b7cf6|#e879f9/i.test(block));
  const hues = [...block.matchAll(/rgba\((?:34, 211, 238|139, 124, 246|232, 121, 249), (0?\.\d+|0|1)\)/g)]
    .map((mm) => Number(mm[1]));
  ok(`${name} block keeps its accent hue restrained`, hues.every((a) => a <= 0.35),
    hues.length ? "alphas " + hues.join(", ") : "no literal accent");
}

/*
 * --- nothing that can promote the window to an opaque surface ---------------
 *
 * backdrop-filter is asserted above. mix-blend-mode is the same class of hazard
 * and was never asserted: it is a compositing operation AGAINST the backdrop, so
 * Chromium can give a transparent window an opaque backing to blend with, and
 * every unpainted region comes out black. The overlay used `mix-blend-mode:
 * screen` on the specular highlight; it is gone, and this is what keeps it gone.
 *
 * filter: on the overlay's own material is listed for the same reason. The
 * `filter: brightness()` on .btn.primary:hover is fine — that is a child element
 * with its own opaque paint, not the window's backing.
 */
for (const banned of ["mix-blend-mode", "backdrop-filter", "-webkit-backdrop-filter"]) {
  ok(`no ${banned} anywhere in the Electron overlay`, !overlay.includes(banned + ":"),
    banned);
}
for (const [name, sel] of [["frame", /\.frame \{[\s\S]*?\n      \}/], ["glass", /\.glass \{[\s\S]*?\n      \}/], ["glass::before", /\.glass::before \{[\s\S]*?\n      \}/]]) {
  const block = overlay.match(sel)?.[0] ?? "";
  ok(`${name} declares no filter or blend of its own`,
    !/\n\s*(filter|mix-blend-mode|backdrop-filter):/.test(block));
}

// --- the waveform is a bar meter ---------------------------------------------
//
// This suite used to assert the opposite: one smooth filled curve with a rim
// light and a specular highlight tracking the peak. That was a deliberate
// design and it is deliberately reversed — at 26px tall the liquid mostly read
// as a grey smear, and a design pass asked for a meter you can see syllables
// in. The assertions are re-pointed rather than deleted, so the next person to
// change it has to mean it the way this change did.
ok("the meter is drawn as discrete bars", overlay.includes("for (let i = 0; i < BARS; i++)"));
// Mirrored about the centre line, so the meter stays anchored to its middle
// however loud it gets.
ok("...drawn outwards from the centre in both directions", overlay.includes("g.moveTo(x, mid - amp)") && overlay.includes("g.lineTo(x, mid + amp)"));
// A silent microphone must still look like a live one: collapsing to zero
// height reads as a dead input, which is the one thing the meter rules out.
ok("a quiet frame floors at a visible dot rather than nothing", overlay.includes("Math.max(barW / 2, v * maxAmp)"));
ok("...with round caps, so that floor is a dot and not a tick", overlay.includes("g.lineCap = \"round\""));
// On this machine's 250% display a bar sized in CSS pixels is a hairline.
ok("bar width scales with the device pixel ratio", overlay.includes("Math.max(1.5 * s, step * 0.42)"));
// Loudness visible as more than height, or a loud passage and a quiet one are
// the same picture at two scales.
ok("bars brighten with amplitude", overlay.includes("0.34 + 0.56 * v"));
// Gone, not merely unused: a dead curve tracer sitting next to a bar renderer
// is the kind of thing that gets called again by accident.
ok("the old curve tracer is gone", !overlay.includes("traceSmooth") && !overlay.includes("quadraticCurveTo"));
ok("...along with the peak-tracking specular highlight", !overlay.includes("createRadialGradient(peakX"));

// --- still driven by the real microphone, still one instance -----------------
// Regression guard: none of the above should have detached the waveform from
// the actual audio level or duplicated the drawing code per canvas.
ok("still driven by the real mic level", /window\.voice\.onLevel/.test(overlay));
ok("one draw function serves both canvases", (overlay.match(/function drawInto\(/g) ?? []).length === 1);

console.log(fails ? `\n${fails} FAILED` : "\nall liquid-glass checks passed");
process.exit(fails ? 1 : 0);

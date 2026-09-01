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
// The base is opaque now: the window stopped being transparent, so there is no
// backdrop left to scrim. The tints and the sheen still sit on top of it.
ok("...over an opaque base rather than a scrimmed backdrop", overlay.includes("rgb(var(--base))"));
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
ok("the glass is still layered, just over a colour", overlay.includes("rgb(var(--base))") && overlay.includes("var(--tint-cyan)") && overlay.includes("var(--tint-violet)"));

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
// No CSS drop shadow to check. The window is opaque, so the shadow is the OS's
// (hasShadow: true) and lives outside the window entirely; a CSS one would be a
// dark band painted ON the panel rather than depth under it.
ok("the frame casts no CSS drop shadow", !overlay.includes("rgba(31, 38, 135"));
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
  // This used to check that every drop-shadow stop fitted inside the
  // transparent margin, because a shadow wider than its window is clipped into
  // a rectangle. Both halves are gone: the window is opaque, so there is no
  // margin, and the shadow is drawn by Windows outside the window where nothing
  // can clip it.
  //
  // What replaces it is the rule that made the old check necessary — an opaque
  // window must not paint an outer shadow ON itself. Inset shadows are the rim
  // lights and are fine; an outer one would be a dark band across the panel.
  const rule = (sel) => {
    const i = overlay.indexOf(sel);
    const endMark = String.fromCharCode(10) + "      }";
    return i === -1 ? "" : overlay.slice(i, overlay.indexOf(endMark, i));
  };
  const outerStops = (css) => {
    const out = [];
    let i = css.indexOf("box-shadow:");
    while (i !== -1) {
      const decl = css.slice(i + 11, css.indexOf(";", i));
      // Blank the colours first, or every rgba() comma splits one stop into three.
      let flat = "", depth = 0;
      for (const ch of decl) {
        if (ch === "(") depth++;
        else if (ch === ")") { depth--; continue; }
        if (depth === 0) flat += ch;
      }
      for (const s of flat.split(",")) {
        const t = s.trim();
        if (t && !t.startsWith("inset")) out.push(t);
      }
      i = css.indexOf("box-shadow:", i + 1);
    }
    return out;
  };
  const frameOuter = outerStops(rule("      .frame {"));
  const glassOuter = outerStops(rule("      .glass {"));
  ok("the frame paints no outer shadow on an opaque window", frameOuter.length === 0, frameOuter.join(" | "));
  ok("...and neither does the glass", glassOuter.length === 0, glassOuter.join(" | "));
  // The rim lights are what still has to be there.
  ok("the inner rim survives", overlay.includes("inset 0 1px 0 0 var(--inner-rim)"));
  // Zero pad, deliberately: a non-zero one is transparent window area again,
  // which is the bug this whole change removes.
  const padTxt = overlay.split("--shadow-pad: ")[1] || "";
  ok("there is no transparent margin left", parseInt(padTxt, 10) === 0, padTxt.slice(0, 6));
}
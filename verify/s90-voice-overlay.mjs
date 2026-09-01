// Verify (voice overlay: contrast, geometry, responsive behaviour).
//
// The overlay is the one surface in the app rendered over a backdrop we do not
// control — the user's desktop. That makes three things un-eyeballable, and all
// three had regressed (VOICE-UI-ISSUES.md #1, #2, #3):
//
//   1. CONTRAST. Light text on a translucent panel over a WHITE desktop is the
//      worst case, and it is not the case anyone screenshots. Computed here from
//      the actual layer stack in the stylesheet rather than trusted.
//   2. GEOMETRY. The pill's ends are semicircular caps, so a round control near
//      the right edge is clipped by the curve long before its bounding box
//      leaves the element. Measured as a real distance to the rounded-rect
//      boundary, not as "it has some padding".
//   3. SIZE. The panel is drawn at whatever size the display allows, so the
//      controls have to survive widths the constants never mention.
//
// Playwright renders the real file; nothing here is a mock of the CSS.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY = "file://" + path.resolve(here, "../electron/voice-overlay.html").replace(/\\/g, "/");

let fails = 0;
const ok = (n, c, extra = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${extra ? ` — ${extra}` : ""}`); if (!c) fails++; };

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.log("SKIP playwright is not installed — overlay rendering not checked");
  process.exit(0);
}

// window.voice does not exist outside Electron; the page throws on load without it.
const SHIM = `window.voice = {
  onState(cb){ window.__state = cb; }, onLevel(cb){ window.__level = cb; },
  onPermissions(cb){ window.__perms = cb; }, resize(s){ window.__resized = s; },
  endSession(){ window.__ended = true; }, stopVoice(){ window.__stopped = true; },
  answerPermission(id, a){ (window.__answers ??= []).push([id, a]); },
};`;

// Launching is a SEPARATE question from importing, and the skip above only
// answered the first one. playwright arrives transitively (via
// @playwright/mcp), so the import always resolves even on a machine that has
// never downloaded a browser — and the launch then fails with a message
// ("AttachConsole failed" on Windows) that says nothing about the real cause.
// A fresh clone running `npm run verify` should be told what to install, not
// handed that.
//
// Only the missing-executable case is skipped. Any other launch failure is a
// real problem and is re-thrown, because silently skipping a suite that COULD
// have run is how a check quietly stops checking.
let browser;
try {
  browser = await chromium.launch();
} catch (err) {
  const msg = String(err?.message ?? err);
  if (/Executable doesn't exist|please run the following command|browserType\.launch/i.test(msg)) {
    console.log("SKIP playwright's browser is not installed — run: npx playwright install chromium");
    process.exit(0);
  }
  throw err;
}

/** Open the overlay at a size, in one of its two states. */
async function open(w, h, { expand = false, backdrop = "#ffffff" } = {}) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  await page.addInitScript(SHIM);
  await page.goto(OVERLAY);
  await page.addStyleTag({ content: `html { background: ${backdrop}; }` });
  await page.evaluate((e) => {
    window.__perms?.([{ id: "1", kind: "bash", name: "Run command", detail: "npm run build" }]);
    if (!e) document.body.classList.remove("expanded"); // a queued request auto-expands
    else document.body.classList.add("expanded");
    window.__state?.({ state: "listening", transcript: "hello there", response: "Hi." });
  }, expand);
  await page.waitForTimeout(120);
  return page;
}

// --- 1. contrast now lives where the pixels are ------------------------------
//
// This used to compute WCAG ratios by parsing the alpha out of .glass's CSS and
// compositing the layers by hand. That worked while the material was one scrim
// over one fill; the moment it became five layers — two tints, a sheen, the
// scrim, a fill — the regex picked the first rgba() it found, which is now the
// violet tint at 0.075, and cheerfully reported 1.13:1 as if the text had gone
// unreadable. It had not. The measurement had.
//
// A number that wrong is worse than no number, so the real ones are measured in
// s110-voice-overlay-render.mjs from an actual transparent Electron window,
// composited over white / black / colour / detail and sampled at the pixels the
// text is actually drawn on. Nothing here parses a stylesheet to guess at what
// the compositor did.

// --- 2. the pill's controls clear its curved edge ----------------------------
//
// The shield used to read as fused to the rim. 10px of padding is 10px only at
// the exact vertical centre; everywhere else the cap eats into it, and the
// notification badge overhangs the shield by 2px on two sides on top of that.
//
// Measured against the FRAME's own rectangle, not the viewport. body carries
// --shadow-pad of transparent padding on every side so the drop shadow has
// somewhere to land, so the viewport is 48px wider and taller than the pill —
// treating it as the pill put the rounded boundary 24px outside where it really
// is and quietly reported ~24px more clearance than every control actually had.
const SHADOW_PAD = 24;
for (const w of [440, 380, 320, 296, 260]) {
  const page = await open(w + SHADOW_PAD * 2, 92 + SHADOW_PAD * 2);
  // The countdown chip is hidden until the main process sends a deadline, so a
  // fixture that never sends one measures it as permanently absent.
  await page.evaluate(() => { idleAt = Date.now() + 48000; renderHint(); });
  const m = await page.evaluate(() => {
    const f = document.querySelector(".frame").getBoundingClientRect();
    const rad = Math.min(f.height, f.width) / 2;
    // Signed distance to the frame's rounded-rect boundary (negative = inside).
    const sdf = (px, py) => {
      const qx = Math.abs(px - (f.left + f.width / 2)) - (f.width / 2 - rad);
      const qy = Math.abs(py - (f.top + f.height / 2)) - (f.height / 2 - rad);
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;
    };
    // Sample the control's own rim, not its bounding box: a circle in the corner
    // of its box is further from the curve than the box is.
    const clearOf = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      if (!b.width) return "hidden";
      let worst = Infinity;
      for (let a = 0; a < 360; a += 6) {
        const t = (a * Math.PI) / 180;
        worst = Math.min(worst, -sdf(b.left + b.width / 2 + Math.cos(t) * b.width / 2,
                                     b.top + b.height / 2 + Math.sin(t) * b.height / 2));
      }
      return Math.round(worst);
    };
    const de = document.documentElement;
    const seen = (id) => { const e = document.getElementById(id); return !!e && e.getBoundingClientRect().width > 0; };
    return {
      frame: [Math.round(f.width), Math.round(f.height)],
      shield: clearOf(document.getElementById("shieldBtn")),
      close: clearOf(document.querySelector(".pillActions .closeBtn")),
      mic: clearOf(document.getElementById("micOffBtn")),
      badge: clearOf(document.getElementById("badge")),
      overflowX: de.scrollWidth - de.clientWidth,
      overflowY: de.scrollHeight - de.clientHeight,
      state: seen("pillState"), hint: seen("pillHint"), countdown: seen("pillCountdown"),
    };
  });

  // The fixture is honest about what it is measuring: if the frame is not the
  // size we asked for, every number below is about some other pill.
  ok(`@${w}px the frame is the pill, not the viewport`, m.frame[0] === w && m.frame[1] === 92, m.frame.join("x"));
  ok(`@${w}px nothing overflows`, m.overflowX === 0 && m.overflowY === 0, `${m.overflowX}/${m.overflowY}`);
  ok(`@${w}px the shield clears the pill's curve`, m.shield >= 6, `${m.shield}px`);
  ok(`@${w}px the × clears the pill's curve`, m.close >= 6, `${m.close}px`);
  // Below 392px of window the pill drops this button so the state label has
  // room to be a whole word — so "hidden" is the correct answer there, and
  // the expanded panel carries the only copy that is always reachable.
  if (w + SHADOW_PAD * 2 > 392) ok(`@${w}px the voice-off button clears the curve`, m.mic >= 6, `${m.mic}px`);
  else ok(`@${w}px the voice-off button steps aside for the label`, m.mic === "hidden");
  ok(`@${w}px the badge stays inside the rim`, m.badge >= 2, `${m.badge}px`);

  // Progressive disclosure, in the order things stop being worth the room. The
  // state label and the controls are never sacrificed; the hint goes first and
  // the countdown second. What must NOT happen is a truncated sentence.
  ok(`@${w}px the state label always survives`, m.state === true);
  // The media queries see the WINDOW, which is the pill plus a pad on each side,
  // so the pill widths where things drop are 48px below the query values.
  if (w > 392 - SHADOW_PAD * 2) ok(`@${w}px the hint is shown`, m.hint === true);
  else ok(`@${w}px the hint is dropped rather than truncated`, m.hint === false);
  if (w > 344 - SHADOW_PAD * 2) ok(`@${w}px the countdown is shown`, m.countdown === true);
  else ok(`@${w}px the countdown is dropped too`, m.countdown === false);

  await page.close();
}

// --- 3. the canvas is drawn at the size it is displayed ----------------------
//
// Both canvases carried hard-coded width/height attributes while their CSS width
// was fluid. The backing store is what you draw into; the CSS box is what it is
// scaled to. Whenever they disagree the waveform is stretched — worse the
// further the window is from the one size the numbers were written for.
// These are PILL sizes. The window is bigger by --shadow-pad on every side, so
// that the pill's drop shadow has somewhere to land instead of being clipped
// into a hard rectangle at the window edge (see boundsFor in voice.js). Opening
// the page at the pill size would squeeze the pill by 48px and squash the
// waveform, which is a bug in the fixture rather than in the page.
for (const [w, h, expand] of [[440, 92, false], [320, 92, false], [720, 320, true], [520, 320, true]]) {
  const page = await open(w + SHADOW_PAD * 2, h + SHADOW_PAD * 2, { expand });
  const m = await page.evaluate(() => {
    const cv = document.body.classList.contains("expanded")
      ? document.getElementById("bigWave") : document.getElementById("pillWave");
    if (!cv || !cv.clientWidth) return { skipped: true };
    return { ar: +(cv.width / cv.clientWidth).toFixed(2), dpr: Math.min(devicePixelRatio, 2) };
  });
  if (m.skipped) { console.log(`SKIP @${w}x${h} the waveform is hidden at this size (by design)`); continue; }
  ok(`@${w}x${h} the canvas backing store matches its display size`, Math.abs(m.ar - m.dpr) < 0.05, `${m.ar}x vs dpr ${m.dpr}`);
  await page.close();
}

// --- 4. the panel survives sizes the constants never mention -----------------
for (const [w, h] of [[720, 320], [520, 320], [720, 240], [420, 300], [360, 200]]) {
  const page = await open(w, h, { expand: true });
  const m = await page.evaluate(() => {
    const el = document.getElementById("closeBtn2").getBoundingClientRect();
    return {
      overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      overflowY: document.documentElement.scrollHeight > innerHeight + 1,
      closeOnScreen: el.width > 0 && el.right <= innerWidth + 0.5 && el.top >= -0.5 && el.bottom <= innerHeight + 0.5,
    };
  });
  ok(`@${w}x${h} nothing overflows the panel`, !m.overflowX && !m.overflowY);
  ok(`@${w}x${h} the × is on screen`, m.closeOnScreen === true);
  await page.close();
}

// --- 5. three exits, three different amounts of damage -----------------------
//
// VOICE-UI-ISSUES.md #5 made the × turn voice off entirely, reasoning that
// closing the thing representing a feature should disable the feature. That is
// not what a × means anywhere else, and it left no way to dismiss the panel
// without disarming the wake word and going to Settings to get it back.
//
//   Esc  -> end this conversation
//   x    -> end this conversation
//   mic  -> stop voice, release the microphone, persist voiceEnabled: false
//
// The two that differ in how hard they are to undo must not share a button.
{
  const page = await open(440, 92);
  await page.click("#collapsed .closeBtn");
  const afterClose = await page.evaluate(() => ({ stopped: !!window.__stopped, ended: !!window.__ended }));
  ok("the × ends the conversation", afterClose.ended === true);
  ok("...and leaves voice on", afterClose.stopped === false);

  const pageM = await open(440 + SHADOW_PAD * 2, 92 + SHADOW_PAD * 2);
  await pageM.click("#micOffBtn");
  const afterMic = await pageM.evaluate(() => ({ stopped: !!window.__stopped, ended: !!window.__ended }));
  ok("the microphone button turns voice off", afterMic.stopped === true);
  ok("...and is the ONLY control that does", afterMic.ended === false);
  await pageM.close();

  const page2 = await open(440 + SHADOW_PAD * 2, 92 + SHADOW_PAD * 2);
  await page2.keyboard.press("Escape");
  const afterEsc = await page2.evaluate(() => ({ stopped: !!window.__stopped, ended: !!window.__ended }));
  ok("Esc ends the conversation", afterEsc.ended === true);
  ok("...and leaves voice on", afterEsc.stopped === false);

  // Clicking the × must not also be read as "expand the panel" — the collapsed
  // row's own click handler opens the panel, and the × sits inside it.
  // __resized is cleared first because open() queues a permission, and a queued
  // permission auto-expands by design.
  const page3 = await open(440, 92);
  await page3.evaluate(() => { window.__resized = undefined; });
  await page3.click("#collapsed .closeBtn");
  ok("the × does not expand the panel on its way out",
    (await page3.evaluate(() => window.__resized)) === undefined);
  await page.close(); await page2.close(); await page3.close();
}

// --- 5b. the controls are actually clickable ---------------------------------
//
// Reported from a live session: "I can't click any of the buttons." The whole
// body is `-webkit-app-region: drag`, so on Windows the OS hit-tests clicks
// against a rectangle list the compositor produces, and anything that is not
// explicitly `no-drag` swallows the click before the page ever sees it. The
// contrast scrim had been a ::after, which forced `z-index: 1` onto the content
// to sit above it — and that extra stacking context is what made those
// rectangles come out wrong. The buttons rendered perfectly and did nothing.
{
  const page = await open(440, 92);
  const m = await page.evaluate(() => {
    const region = (el) => getComputedStyle(el).getPropertyValue("-webkit-app-region").trim();
    const shield = document.getElementById("shieldBtn");
    const close = document.querySelector("#collapsed .closeBtn");
    // Every ancestor between the button and <body> must not re-enter a drag
    // region, or the button's own no-drag is fighting its parent.
    const chainDrag = (el) => {
      const out = [];
      for (let n = el; n && n !== document.body; n = n.parentElement) out.push([n.id || n.className, region(n)]);
      return out;
    };
    return {
      shield: region(shield),
      close: region(close),
      chain: chainDrag(shield),
      // No stacking context may sit between the glass and the controls.
      stacking: (() => {
        const bad = [];
        for (let n = shield.parentElement; n && n !== document.body; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (cs.zIndex !== "auto" && cs.position !== "static") bad.push(`${n.id || n.className}:z${cs.zIndex}`);
        }
        return bad;
      })(),
      hasAfterScrim: getComputedStyle(document.querySelector(".glass"), "::after").content !== "none",
    };
  });
  ok("the shield opts out of the drag region", m.shield === "no-drag", m.shield);
  ok("the × opts out of the drag region", m.close === "no-drag", m.close);
  // Only the chain UP TO the content root has to be no-drag. `.glass` and
  // `.frame` stay draggable on purpose — they are the panel's move handle, and a
  // floating window you cannot move is its own bug. What must not happen is a
  // drag region sitting between a button and the content root.
  {
    const upToRoot = [];
    for (const [name, r] of m.chain) {
      upToRoot.push([name, r]);
      if (String(name).includes("collapsed")) break;
    }
    ok("...and nothing between them and the content root is draggable",
      !upToRoot.some(([, r]) => r === "drag"), JSON.stringify(upToRoot));
    ok("the panel itself is still draggable, so it can be moved",
      m.chain.some(([name, r]) => String(name).includes("glass") && r === "drag"));
  }
  ok("no stacking context sits between the glass and the controls",
    m.stacking.length === 0, m.stacking.join(", "));
  ok("the scrim is a background layer, not a ::after over the content", m.hasAfterScrim === false);

  // And the clicks land: the real proof, not a proxy for it.
  await page.evaluate(() => { window.__resized = undefined; window.__stopped = false; });
  await page.click("#collapsed .closeBtn");
  ok("clicking the × reaches the page", (await page.evaluate(() => window.__ended)) === true);
  const page2 = await open(440, 92);
  await page2.click("#shieldBtn");
  ok("clicking the shield reaches the page", (await page2.evaluate(() => window.__resized)) !== undefined);
  await page.close(); await page2.close();
}

// --- 6. the retired SVG filter is really gone --------------------------------
{
  const page = await open(440, 92);
  const m = await page.evaluate(() => ({
    filter: !!document.getElementById("liquidDistort"),
    backdrop: getComputedStyle(document.querySelector(".glass")).backdropFilter,
  }));
  ok("the animated turbulence filter is gone", m.filter === false);
  ok("...and nothing still references it from backdrop-filter", !/url\(/.test(m.backdrop));
  await page.close();
}

// --- the pill's shadow has room, and both halves agree about how much --------
//
// The window used to be sized to exactly the pill. .frame casts a 32px and a
// 48px drop shadow, a shadow paints OUTSIDE its element, and so it was clipped
// at the window rectangle — the pill appeared to sit inside a hard-edged dark
// box, worst on a scaled display where the blur radii are multiplied. The fix
// is transparent room on every side, which only works if voice.js and the
// stylesheet use the SAME number. Nothing else would notice if they drifted:
// too little room re-clips the shadow, too much shrinks the pill, and both
// still render.
{
  const { readFileSync } = await import("node:fs");
  const js = readFileSync(new URL("../electron/voice.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../electron/voice-overlay.html", import.meta.url), "utf8");
  const inJs = js.split("const SHADOW_PAD = ")[1]?.match(/[0-9]+/)?.[0];
  const inCss = css.split("--shadow-pad:")[1]?.match(/[0-9]+/)?.[0];
  ok("voice.js reserves room for the shadow", inJs !== undefined, String(inJs));
  ok("the stylesheet insets the pill by the same amount", inCss !== undefined && inCss === inJs, `css ${inCss} vs js ${inJs}`);
  // The window has to be the bigger of the two, or the padding just eats the pill.
  ok("the window is grown, not the pill shrunk", js.includes("to.w + SHADOW_PAD * 2") && js.includes("to.h + SHADOW_PAD * 2"));
  // Growing the window pushes the pill up unless the offset compensates.
  ok("...and the pill keeps its distance from the screen edge", js.includes("- 48 + SHADOW_PAD"));
}

await browser.close();
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

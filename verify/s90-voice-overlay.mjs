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

// --- 1. contrast, computed from the rendered layer stack ---------------------
//
// Composited in the browser rather than re-derived here: getComputedStyle gives
// the real fill, scrim and backdrop-filter the stylesheet ended up with, so this
// keeps holding if those values are retuned.
{
  const page = await open(720, 320, { expand: true, backdrop: "#ffffff" });
  const r = await page.evaluate(() => {
    const parse = (s) => (s.match(/[\d.]+/g) ?? []).map(Number);
    const glass = getComputedStyle(document.querySelector(".glass"));
    const fill = parse(glass.backgroundColor);      // rgba(255,255,255,F)
    // The contrast scrim is a background LAYER on .glass, not a ::after — a
    // pseudo-element paints above in-flow children and needed a z-index to sit
    // under them, and that stacking context broke click hit-testing on Windows.
    // Read the first rgba() in the background-image gradient.
    const grad = glass.backgroundImage || "";
    const sc = parse((/rgba?\([^)]*\)/.exec(grad) ?? ["rgba(0,0,0,0)"])[0]);
    const bright = Number(/brightness\(([\d.]+)\)/.exec(glass.backdropFilter)?.[1] ?? 1);

    const over = (fg, a, bg) => fg.map((c, i) => c * a + bg[i] * (1 - a));
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const L = (v) => { const [x, y, z] = v.map(lin); return 0.2126 * x + 0.7152 * y + 0.0722 * z; };
    const ratio = (a, b) => { const l1 = L(a), l2 = L(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

    // Worst case: a pure-white desktop behind the glass, on bare glass (no card
    // of its own to help). Composite order matches paint order — the backdrop is
    // clamped, then the background-color fill, then the gradient layer above it.
    let s = [1, 1, 1].map((c) => c * bright);
    s = over(fill.slice(0, 3).map((c) => c / 255), fill[3] ?? 1, s);
    s = over(sc.slice(0, 3).map((c) => c / 255), sc[3] ?? 1, s);

    const css = getComputedStyle(document.documentElement);
    const tok = (n) => parse(css.getPropertyValue(n)).map((c) => c / 255);
    // Read the tokens as the browser resolved them, via a probe element.
    const probe = document.createElement("span");
    document.body.appendChild(probe);
    const colorOf = (v) => { probe.style.color = v; return parse(getComputedStyle(probe).color).map((c) => c / 255); };
    const out = { bright, fillA: fill[3], scrimA: sc[3] };
    for (const n of ["--text", "--dim", "--dimmer"]) out[n] = +ratio(colorOf(`var(${n})`), s).toFixed(2);
    probe.remove();
    void tok;
    return out;
  });
  console.log(`    (backdrop-filter brightness=${r.bright}, fill alpha=${r.fillA}, scrim alpha=${r.scrimA})`);
  ok("--text clears WCAG AA over a WHITE desktop", r["--text"] >= 4.5, `${r["--text"]}:1`);
  ok("--dim clears WCAG AA over a WHITE desktop", r["--dim"] >= 4.5, `${r["--dim"]}:1`);
  ok("--dimmer clears WCAG AA over a WHITE desktop", r["--dimmer"] >= 4.5, `${r["--dimmer"]}:1`);
  ok("the backdrop is actually clamped (this is what makes the above possible)", r.bright < 1);
  await page.close();
}

// --- 2. the pill's controls clear its curved edge ----------------------------
//
// The shield used to read as fused to the rim. 10px of padding is 10px only at
// the exact vertical centre; everywhere else the cap eats into it, and the
// notification badge overhangs the shield by 2px on two sides on top of that.
for (const w of [440, 380, 320, 260]) {
  const page = await open(w, 92);
  const m = await page.evaluate(() => {
    const W = innerWidth, H = innerHeight, rad = Math.min(H, W) / 2;
    // Signed distance to the pill's rounded-rect boundary (negative = inside).
    const sdf = (px, py) => {
      const qx = Math.abs(px - W / 2) - (W / 2 - rad);
      const qy = Math.abs(py - H / 2) - (H / 2 - rad);
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;
    };
    const clearOf = (el) => {
      const b = el.getBoundingClientRect();
      if (!b.width) return null;
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2, r = b.width / 2;
      let worst = Infinity;
      for (let a = 0; a < 360; a += 5) {
        const t = (a * Math.PI) / 180;
        worst = Math.min(worst, -sdf(cx + r * Math.cos(t), cy + r * Math.sin(t)));
      }
      return +worst.toFixed(1);
    };
    const badge = document.getElementById("badge").getBoundingClientRect();
    return {
      shield: clearOf(document.getElementById("shieldBtn")),
      close: clearOf(document.querySelector("#collapsed .closeBtn")),
      badge: badge.width ? +Math.min(-sdf(badge.right, badge.top), -sdf(badge.right, badge.bottom)).toFixed(1) : null,
      closeVisible: document.querySelector("#collapsed .closeBtn").getBoundingClientRect().right <= innerWidth + 0.5,
    };
  });
  // 6px is the floor at which it stops reading as "attached to the edge".
  ok(`@${w}px the shield clears the pill's curve`, m.shield >= 6, `${m.shield}px`);
  ok(`@${w}px the × clears the pill's curve`, m.close >= 6, `${m.close}px`);
  ok(`@${w}px the badge stays inside the rim`, m.badge >= 2, `${m.badge}px`);
  ok(`@${w}px the × is not clipped off the edge`, m.closeVisible === true);
  await page.close();
}

// --- 3. the canvas is drawn at the size it is displayed ----------------------
//
// Both canvases carried hard-coded width/height attributes while their CSS width
// was fluid. The backing store is what you draw into; the CSS box is what it is
// scaled to. Whenever they disagree the waveform is stretched — worse the
// further the window is from the one size the numbers were written for.
for (const [w, h, expand] of [[440, 92, false], [320, 92, false], [720, 320, true], [520, 320, true]]) {
  const page = await open(w, h, { expand });
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

// --- 5. the × turns voice off; Esc only ends the conversation ----------------
//
// The whole point of VOICE-UI-ISSUES.md #5: these were the same call, so closing
// the panel left the wake word armed and the app still listening.
{
  const page = await open(440, 92);
  await page.click("#collapsed .closeBtn");
  const afterClose = await page.evaluate(() => ({ stopped: !!window.__stopped, ended: !!window.__ended }));
  ok("the × calls stopVoice (turns the feature off)", afterClose.stopped === true);
  ok("...and not merely endSession", afterClose.ended === false);

  const page2 = await open(440, 92);
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
  ok("clicking the × reaches the page", (await page.evaluate(() => window.__stopped)) === true);
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

await browser.close();
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

// Electron half of s110-voice-overlay-render.mjs.
//
// Separate, and CommonJS, for two reasons: the measurements need a real
// transparent BrowserWindow (a normal Chromium page cannot show whether the
// window's own backing went opaque), and Electron's main process here does not
// run an ESM entry point with top-level await — it hangs with no output, which
// is a bad way for a test suite to fail.
//
// Prints one JSON object on stdout. All judgement lives in the .mjs.
const { app, BrowserWindow, nativeImage } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
// Overridable so the same probe can render an OLD copy of the overlay into a
// different folder, which is how the before/after pair is produced.
const SHOTS = process.env.OVERLAY_SHOTS || path.join(root, "verify", "_shots");
const PAGE = process.env.OVERLAY_PAGE || path.join(root, "electron", "voice-overlay.html");
const PAD = 24;
const out = { probes: {}, contrast: {}, states: {}, copy: {}, rail: {}, a11y: null, behaviour: {}, shots: 0, error: null };

setTimeout(() => { console.log(JSON.stringify({ ...out, error: "timed out" })); app.exit(0); }, 90000);

const drive = (expand, state, countdown) =>
  "(() => { document.body.classList.toggle('expanded', " + expand + ");" +
  " applyState('" + state + "');" +
  " baseHint = 'Esc or \u00d7 ends this chat';" +
  " idleAt = " + (countdown ? "Date.now() + 48000" : "0") + "; renderHint(); })()";

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  let win;
  try {
    win = new BrowserWindow({
      x: 40, y: 40, width: 440 + PAD * 2, height: 92 + PAD * 2,
      frame: false, transparent: true, backgroundColor: "#00000000",
      resizable: false, skipTaskbar: true, alwaysOnTop: true, show: false,
      focusable: true, hasShadow: false,
      // WITHOUT this the page's script threw at its first window.voice call and
      // silently stopped — see the note at the top of _overlay-preload.cjs. The
      // geometry checks passed anyway, which is why it went unnoticed.
      webPreferences: { preload: path.join(root, "verify", "_overlay-preload.cjs"), contextIsolation: true, sandbox: false },
    });
    await win.loadFile(PAGE);
    // Loud, because a throw in the page's own script leaves a DOM that looks
    // plausible and measures wrong.
    out.pageOk = await win.webContents.executeJavaScript(
      "(() => ({ bridge: typeof window.voice === 'object'," +
      " ready: typeof applyState === 'function' && typeof render === 'function'," +
      " pane: !!document.getElementById('pane').children.length," +
      " errors: (window.__pageErrors || []).slice(0, 3) }))()");

    const shot = async (pillW, pillH, opts) => {
      const o = opts || {};
      win.setBounds({ x: 40, y: 40, width: pillW + PAD * 2, height: pillH + PAD * 2 });
      await win.webContents.executeJavaScript(drive(!!o.expand, o.state || "listening", o.countdown !== false));
      await new Promise((r) => setTimeout(r, 150));
      const img = await win.webContents.capturePage();
      const size = img.getSize();
      const bmp = img.getBitmap();
      const px = (x, y) => {
        const i = (Math.round(y) * size.width + Math.round(x)) * 4;
        return [bmp[i + 2], bmp[i + 1], bmp[i], bmp[i + 3]];
      };
      return { img, bmp, width: size.width, height: size.height, px, dpr: size.width / (pillW + PAD * 2) };
    };

    // 1. transparency of every region the page does not paint
    {
      const s = await shot(440, 92);
      out.probes["top-left"] = s.px(1, 1)[3];
      out.probes["top-right"] = s.px(s.width - 2, 1)[3];
      out.probes["bottom-left"] = s.px(1, s.height - 2)[3];
      out.probes["bottom-right"] = s.px(s.width - 2, s.height - 2)[3];
      out.probes["mid-top"] = s.px(s.width / 2, 1)[3];
      out.probes["mid-left"] = s.px(1, s.height / 2)[3];
      out.probes["shadow-margin"] = s.px((PAD * s.dpr) / 2, s.height / 2)[3];
      out.probes["pill-body"] = s.px(s.width / 2, s.height / 2)[3];
    }

    // 2. contrast, from the pixels rather than the stylesheet
    {
      const s = await shot(440, 92);
      const box = await win.webContents.executeJavaScript(
        "(() => { const b = document.getElementById('pillState').getBoundingClientRect();" +
        " return { x: b.left, y: b.top, w: b.width, h: b.height }; })()");
      let glyph = null;
      for (let y = box.y; y < box.y + box.h; y++) {
        for (let x = box.x; x < box.x + box.w; x++) {
          const p = s.px(x * s.dpr, y * s.dpr);
          if (!glyph || p[0] + p[1] + p[2] > glyph[0] + glyph[1] + glyph[2]) glyph = p;
        }
      }
      out.contrast.glyph = glyph;
      out.contrast.surface = s.px(s.width / 2, (box.y + box.h + 16) * s.dpr);
    }

    // 3. state synchronisation, read off the rendered DOM
    try {
      const READ = "(() => ({ pill: document.getElementById('pillState').textContent," +
        " big: document.getElementById('bigState').textContent," +
        " lit: ['stepListening','stepProcessing','stepAnswering'].filter(i => document.getElementById(i).classList.contains('on'))," +
        " orb: document.body.dataset.state }))()";
      for (const st of ["listening", "thinking", "speaking", "error"]) {
        await shot(720, 320, { expand: true, state: st });
        out.states[st] = await win.webContents.executeJavaScript(READ);
      }

    } catch (e) { out.states._error = String(e && e.message); }


    // 3b. the status rail: one row, no overlap, and what the narrow fallback does
    //
    // Measured off getBoundingClientRect on the real rendered chips. "One row"
    // is not "flex-wrap is nowrap" — a nowrap row can still overflow its
    // container, and the failure this replaces was chips at DIFFERENT y values,
    // so the tops are what gets compared.
    try {
      const RAIL = "(() => {" +
        " const r = (el) => { const b = el.getBoundingClientRect();" +
        "   return { x: b.left, y: b.top, w: b.width, h: b.height, r: b.right, b: b.bottom }; };" +
        " const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);" +
        " const ids = ['stepListening','stepProcessing','stepAnswering'];" +
        " const shown = ids.filter((i) => vis(document.getElementById(i)));" +
        " const rail = document.querySelector('.rail'); const steps = document.querySelector('.steps');" +
        " const hint = document.getElementById('escHint'); const left = document.querySelector('.left');" +
        " return {" +
        "   container: rail.getBoundingClientRect().width," +
        "   shown: shown," +
        "   lit: ids.filter((i) => document.getElementById(i).classList.contains('on'))," +
        "   litShown: shown.filter((i) => document.getElementById(i).classList.contains('on'))," +
        "   tops: shown.map((i) => Math.round(r(document.getElementById(i)).y))," +
        "   rowRight: shown.length ? Math.max.apply(null, shown.map((i) => r(document.getElementById(i)).r)) : 0," +
        "   stepsRect: r(steps), railRect: r(rail), hintRect: r(hint)," +
        "   hintVisible: vis(hint)," +
        "   hintText: Array.from(hint.children).filter(vis).map((c) => c.textContent).join('').trim()," +
        "   tabRows: new Set(Array.from(document.querySelectorAll('.tab')).map((t) => Math.round(t.getBoundingClientRect().top))).size," +
        "   tabsRight: Math.max.apply(null, Array.from(document.querySelectorAll('.tab')).map((t) => t.getBoundingClientRect().right))," +
        "   cornerLeft: Math.min.apply(null, Array.from(document.querySelectorAll('.right > button')).map((b) => b.getBoundingClientRect().left))," +
        "   hintClipped: hint.scrollWidth - hint.clientWidth > 1," +
        "   stepsOverflow: steps.scrollWidth - steps.clientWidth > 1," +
        "   transcript: r(document.getElementById('transcript'))," +
        "   response: r(document.getElementById('response'))," +
        "   leftRect: r(left)," +
        "   leftOverflow: left.scrollHeight - left.clientHeight > 1" +
        " }; })()";
      // 720 is the design width; 560 is the last width before the columns stack,
      // which is where the left column is at its narrowest as a COLUMN.
      for (const c of [[720, "listening"], [720, "thinking"], [720, "speaking"], [720, "error"],
                       [600, "speaking"], [560, "speaking"],
                       [320, "speaking"], [260, "speaking"], [212, "speaking"], [212, "error"]]) {
        await shot(c[0], 320, { expand: true, state: c[1] });
        out.rail[c[0] + ":" + c[1]] = await win.webContents.executeJavaScript(RAIL);
      }
    } catch (e) { out.rail._error = String(e && e.message); }

    // 3c. every icon-only control has an accessible name, and no control is
    //     wired so that clicking it also expands the pill.
    try {
      await shot(440, 92);
      out.a11y = await win.webContents.executeJavaScript(
        "(() => Array.from(document.querySelectorAll('button')).map((b) => ({" +
        " id: b.id || b.className," +
        " text: (b.textContent || '').trim()," +
        " aria: b.getAttribute('aria-label') || ''," +
        " title: b.getAttribute('title') || ''" +
        " })))()");
      /*
       * The expand handler and the exit semantics are the two things a
       * screenshot cannot show. Drive real clicks through the real listeners and
       * read back WHICH bridge call each one made, plus whether the pill
       * expanded on the way out — clicking "turn voice off" used to open the
       * panel as well, because the guard listed two control ids and there were
       * three controls.
       */
      out.behaviour = await win.webContents.executeJavaScript(
        "(() => {" +
        " const res = {};" +
        " const run = (name, fn) => { setExpanded(false); window.__probe.clear(); fn();" +
        "   res[name] = { calls: window.__probe.calls(), expanded: document.body.classList.contains('expanded') }; };" +
        " run('closeBtn', () => document.getElementById('closeBtn').click());" +
        " run('micOffBtn', () => document.getElementById('micOffBtn').click());" +
        " run('shieldBtn', () => document.getElementById('shieldBtn').click());" +
        " run('escape', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));" +
        " run('pillBody', () => document.querySelector('.pillText').click());" +
        " res.shieldTab = (document.querySelector('.tab.active') || {}).dataset.tab;" +
        " setExpanded(false); window.__probe.clear();" +
        " run('closeBtn2', () => document.getElementById('closeBtn2').click());" +
        " run('micOffBtn2', () => document.getElementById('micOffBtn2').click());" +
        " return res; })()");
    } catch (e) { out.behaviour._error = String(e && e.message); }

    // 4. does the collapsed copy fit, at every supported width
    try {
      const FITS = "(() => { const f = (id) => { const e = document.getElementById(id);" +
        " if (!e || !e.getBoundingClientRect().width) return 'hidden';" +
        " return e.scrollWidth - e.clientWidth <= 0; };" +
        " return { state: f('pillState'), hint: f('pillHint'), countdown: f('pillCountdown') }; })()";
      for (const w of [440, 392, 344, 320, 296, 260]) {
        await shot(w, 92);
        out.copy[w] = await win.webContents.executeJavaScript(FITS);
      }

    } catch (e) { out.copy._error = String(e && e.message); }

    // 5. composited screenshots, for a person to look at
    {
      mkdirSync(SHOTS, { recursive: true });
      const backdrops = [["white", [255, 255, 255]], ["black", [0, 0, 0]], ["colour", [46, 122, 214]]];
      const views = [
        ["collapsed-440", 440, 92, {}],
        ["collapsed-260", 260, 92, {}],
        ["expanded-720", 720, 320, { expand: true, state: "speaking" }],
        ["expanded-360", 360, 320, { expand: true }],
        // The narrow expanded panel that still has TWO columns — this is the one
        // that exercises the rail's compact fallback, which the 360px stacked
        // view does not (stacked, the left column is the full panel width).
        ["expanded-narrow", 600, 320, { expand: true, state: "speaking" }],
        // One view per state, so the rail's active styling can be compared
        // side by side rather than described.
        ["expanded-720-listening", 720, 320, { expand: true, state: "listening" }],
        ["expanded-720-processing", 720, 320, { expand: true, state: "thinking" }],
        ["expanded-720-answering", 720, 320, { expand: true, state: "speaking" }],
      ];
      for (const v of views) {
        const s = await shot(v[1], v[2], v[3]);
        for (const b of backdrops) {
          const buf = Buffer.alloc(s.width * s.height * 4);
          for (let i = 0; i < s.width * s.height; i++) {
            const o = i * 4;
            const a = s.bmp[o + 3] / 255;
            // getBitmap is BGRA; the backdrop is RGB, so it indexes in reverse.
            for (let c = 0; c < 3; c++) buf[o + c] = Math.round(s.bmp[o + c] * a + b[1][2 - c] * (1 - a));
            buf[o + 3] = 255;
          }
          writeFileSync(path.join(SHOTS, v[0] + "-on-" + b[0] + ".png"),
            nativeImage.createFromBitmap(buf, { width: s.width, height: s.height }).toPNG());
          out.shots++;
        }
      }
    }
  } catch (e) {
    out.error = String((e && e.message) || e);
  } finally {
    if (win) win.destroy();
    console.log(JSON.stringify(out));
    app.exit(0);
  }
});

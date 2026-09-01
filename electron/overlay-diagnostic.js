/**
 * The one overlay check that no test can do: LOOK at it on the real desktop.
 *
 * Everything else about this panel is measured. verify/s110 opens a genuine
 * transparent BrowserWindow and reads the alpha channel back with capturePage(),
 * which catches the backdrop-filter class of bug — but capturePage() reads the
 * WINDOW's own buffer, not the screen. What it cannot see is the last step:
 * whether the Windows desktop compositor, at this machine's real scaling, on
 * this GPU, with this driver, actually blends that buffer onto what is behind
 * it, or hands the window an opaque backing and paints a black rectangle.
 *
 * So this exists: a mode that puts the real overlay window — the same
 * BrowserWindow options voice.js uses — on top of the backdrops that matter, and
 * asks a person to look. It runs from the PACKAGED app, because "it works from
 * source" is a different claim.
 *
 *   Packaged:  set GNOSIS_OVERLAY_DIAGNOSTIC=1 and launch Gnosis.exe
 *   From src:  npm run overlay:check
 *
 * Keys, once it is up:
 *   Space  collapsed <-> expanded
 *   1/2/3/4  listening / processing / answering / error
 *   B      cycle the backdrop behind it (white / black / colour / detail / none)
 *   M      move it to the next display
 *   Q/Esc  quit
 *
 * The checklist it prints is the thing to answer. It is short on purpose.
 */
import { app, BrowserWindow, globalShortcut, screen } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Kept in sync with SHADOW_PAD in voice.js and --shadow-pad in the stylesheet. */
const PAD = 24;
const SIZES = { collapsed: { w: 440, h: 92 }, expanded: { w: 720, h: 320 } };

/*
 * The backdrops. These are the four cases the requirements name, as real
 * always-on-top windows rather than a screenshot composite — a composite proves
 * the alpha channel is right, which is already tested; only a real window
 * underneath proves the COMPOSITOR honours it.
 */
const BACKDROPS = [
  ["white", "#ffffff"],
  ["black", "#000000"],
  ["colour", "linear-gradient(135deg,#ff2d55,#ffcc00 40%,#00c2ff 70%,#7d3cff)"],
  ["detail", "repeating-conic-gradient(#1b2a41 0% 25%, #c8b08a 0% 50%) 0/26px 26px"],
  ["none (bare desktop)", null],
];

const CHECKLIST = `
------------------------------------------------------------------------
OVERLAY DIAGNOSTIC — answer these, they are the whole point of this mode
------------------------------------------------------------------------
Press B to cycle the backdrop, Space to expand/collapse, M to change monitor.

 1. Outside the rounded panel, do you see the backdrop, or a BLACK rectangle?
 2. The soft shadow around the panel — does it fade out, or stop at a hard edge?
 3. Press Space a few times. Does anything flash black during the resize?
 4. Press M. After it moves to the other display, still no black box?
 5. Press B to "none". Over the bare desktop, are the corners transparent?
 6. Click the shield: does the panel expand? Click x: does it close the chat?
 7. Is the state label readable over the white AND the detailed backdrop?

A NO to 1-5 is the bug this mode exists to find. Report which one.
------------------------------------------------------------------------
`;

export function runOverlayDiagnostic() {
  let overlay = null;
  let back = null;
  let backIdx = 0;
  let expanded = false;
  let displayIdx = 0;

  const boundsFor = (state, area) => {
    const to = SIZES[state];
    const w = to.w + PAD * 2;
    const h = to.h + PAD * 2;
    return {
      x: Math.round(area.x + (area.width - w) / 2),
      y: Math.round(area.y + area.height - h - 48 + PAD),
      width: w, height: h,
    };
  };

  const displays = () => screen.getAllDisplays();
  const area = () => displays()[displayIdx % displays().length].workArea;

  const showBackdrop = () => {
    if (back && !back.isDestroyed()) back.destroy();
    back = null;
    const [name, css] = BACKDROPS[backIdx % BACKDROPS.length];
    console.log(`backdrop: ${name}`);
    if (!css) return;
    const a = area();
    back = new BrowserWindow({
      x: a.x + 60, y: a.y + 60, width: Math.min(1100, a.width - 120), height: Math.min(720, a.height - 120),
      frame: false, alwaysOnTop: true, skipTaskbar: true, focusable: false,
    });
    // Below the overlay, above everything else — "normal" vs "screen-saver" is
    // what puts the overlay on top of this and not the other way round.
    back.setAlwaysOnTop(true, "normal");
    back.loadURL("data:text/html," + encodeURIComponent(
      `<body style="margin:0;height:100vh;background:${css}"></body>`));
  };

  const place = () => {
    if (overlay && !overlay.isDestroyed()) {
      overlay.setBounds(boundsFor(expanded ? "expanded" : "collapsed", area()), true);
    }
  };

  app.whenReady().then(async () => {
    showBackdrop();

    /*
     * These options are COPIED from makeOverlay() in voice.js and must stay
     * copied. A diagnostic that configures its own window differently is a
     * diagnostic of a window nobody ships.
     */
    overlay = new BrowserWindow({
      ...boundsFor("collapsed", area()),
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: path.join(here, "voice-preload.cjs"),
        contextIsolation: true,
        sandbox: false,
      },
    });
    overlay.setAlwaysOnTop(true, "screen-saver");
    await overlay.loadFile(path.join(here, "voice-overlay.html"));
    overlay.showInactive();

    // The page's bridge is the real one and nothing is listening on the other
    // end, so drive the page directly. Same functions the app's IPC drives.
    const drive = (js) => overlay.webContents.executeJavaScript(js).catch(() => {});
    await drive("baseHint = 'Esc or × ends this chat'; idleAt = Date.now() + 48000; renderHint();"
      + " document.getElementById('transcript').textContent = 'what is the weather in Ottawa';"
      + " document.getElementById('response').textContent = 'It is 4 degrees and overcast, with rain expected this evening.';");

    const setState = (s) => drive(`applyState('${s}')`);
    const toggle = () => {
      expanded = !expanded;
      drive(`document.body.classList.toggle('expanded', ${expanded})`);
      place();
    };

    globalShortcut.register("Space", toggle);
    globalShortcut.register("1", () => setState("listening"));
    globalShortcut.register("2", () => setState("thinking"));
    globalShortcut.register("3", () => setState("speaking"));
    globalShortcut.register("4", () => setState("error"));
    globalShortcut.register("B", () => { backIdx++; showBackdrop(); });
    globalShortcut.register("M", () => { displayIdx++; showBackdrop(); place(); });
    const quit = () => { globalShortcut.unregisterAll(); app.exit(0); };
    globalShortcut.register("Q", quit);
    globalShortcut.register("Escape", quit);

    console.log(CHECKLIST);
    console.log(`displays: ${displays().length}, scale factor: ${displays().map((d) => d.scaleFactor).join(", ")}`);
  });

  app.on("window-all-closed", () => app.exit(0));
}

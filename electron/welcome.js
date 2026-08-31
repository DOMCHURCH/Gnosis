// The first-run window: disclosure, and where voice is introduced.
//
// Two things the app previously never said out loud.
//
// WHAT LEAVES THE MACHINE. Gnosis collects nothing — no telemetry, no account,
// no servers of ours at all — but it is not an offline app: prompts go to
// OpenRouter, speech to Groq, searches to Brave. Both halves have to be said. A
// bare "we don't collect data" would be technically true and materially
// misleading, and burying the rest in a LICENSE file nobody opens is not
// disclosure either.
//
// THAT VOICE EXISTS. It is off by default and invisible until you happen to know
// the wake phrase, so a user could run Gnosis for a month without discovering
// it. A microphone the user has never been told about is exactly the feature
// that should be surfaced up front, together with its current state.
//
// Shown on a fresh install, and again when the accepted version differs from the
// running one — an update can change what the app is able to do, which is
// precisely when the disclosure is worth repeating.

import { BrowserWindow, ipcMain, app } from "electron";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

let win = null;

/**
 * Gnosis's version — from OUR package.json, not app.getVersion().
 *
 * `app.getVersion()` returns Electron's own version when the app is not
 * packaged: running `electron electron/main.js` in dev reported "44.0.0" and
 * stored that as the accepted version. Anything compared against it afterwards
 * looks older, so the welcome window would never appear again — on a real 1.2.0
 * install it would have been silently suppressed forever by a number that has
 * nothing to do with this app.
 *
 * Read the manifest instead, and fall back to app.getVersion() only if that
 * fails. A version this is wrong about does not just mis-label a window; it
 * decides whether the disclosure is ever shown.
 */
function gnosisVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8"));
    if (pkg?.version) return String(pkg.version);
  } catch {
    /* packaged layouts differ — fall through */
  }
  try {
    return app.getVersion();
  } catch {
    return "0.0.0";
  }
}

/** Compare "1.2.0" style versions on major.minor only — a patch release does not
 * warrant re-showing this, a feature release does. */
function significantlyNewer(accepted, current) {
  if (!accepted) return true;
  const part = (v) => String(v ?? "").split(".").map((n) => Number(n) || 0);
  const [aMaj, aMin] = part(accepted);
  const [cMaj, cMin] = part(current);
  return cMaj > aMaj || (cMaj === aMaj && cMin > aMin);
}

/**
 * Show the welcome window if it has not been accepted for this version.
 *
 * The voice toggle inside the window calls the same `settings:set-voice` IPC
 * the Settings panel does, rather than being handed its own handler — one code
 * path means the two switches cannot disagree about whether voice is on.
 *
 * @param getWindow  the main window, to parent onto
 * @returns true when the window was shown
 */
export async function maybeShowWelcome({ getWindow }) {
  const { loadConfig, saveConfig } = await import("../dist/config.js");
  const config = (await loadConfig()) ?? {};
  const version = gnosisVersion();
  const accepted = config.acceptedVersion ?? null;
  if (!significantlyNewer(accepted, version)) return false;

  const updated = !!accepted;

  ipcMain.removeHandler?.("welcome:info");
  ipcMain.handle("welcome:info", async () => {
    // Re-read rather than closing over the value: the user may have toggled
    // voice from Settings while this window was open.
    const fresh = (await loadConfig()) ?? {};
    return { version, updated, voiceEnabled: !!fresh.voiceEnabled };
  });

  ipcMain.removeAllListeners("welcome:accept");
  ipcMain.on("welcome:accept", () => {
    // Record acceptance BEFORE closing, so a crash on close cannot lose it and
    // show the same window again next launch.
    void saveConfig({ acceptedVersion: version })
      .catch(() => {})
      .finally(() => {
        if (win && !win.isDestroyed()) win.close();
      });
  });

  const host = getWindow?.();
  win = new BrowserWindow({
    width: 640,
    height: 720,
    parent: host && !host.isDestroyed() ? host : undefined,
    modal: false, // not modal: a modal that fails to close would lock the app out
    backgroundColor: "#0d0d12",
    title: "Welcome to Gnosis",
    icon: path.join(here, "icon.png"),
    autoHideMenuBar: true,
    resizable: true,
    minimizable: false,
    show: false,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => { win = null; });
  void win.loadFile(path.join(here, "welcome.html"));

  return true;
}

/** Re-open it on demand (a Settings button, or a tray item). */
export async function showWelcome(opts) {
  if (win && !win.isDestroyed()) { win.focus(); return true; }
  const { loadConfig, saveConfig } = await import("../dist/config.js");
  const c = (await loadConfig()) ?? {};
  await saveConfig({ acceptedVersion: null }).catch(() => {});
  const shown = await maybeShowWelcome(opts);
  if (!shown) await saveConfig({ acceptedVersion: c.acceptedVersion ?? null }).catch(() => {});
  return shown;
}

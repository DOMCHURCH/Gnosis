// The settings window and its IPC.
//
// Deliberately a native window rather than a panel in the web UI: the web UI is
// also what `dom serve` exposes on the LAN, and "type your API key here" does not
// belong on a surface reachable from another machine. Only pages loaded from disk
// with our preload can reach these handlers — the window showing the agent UI has
// no preload at all, so nothing served over HTTP can call them.

import { BrowserWindow, ipcMain, app } from "electron";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv, mergeEnv, maskSecret } from "./env-file.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The only keys this panel may write. The renderer names the key to set, so
 * without this an injected page could write arbitrary entries into .env. */
const KNOWN_KEYS = ["OPENROUTER_API_KEY", "BRAVE_API_KEY"];

let win = null;

async function envFilePath() {
  // Imported rather than rebuilt from os.homedir() so there is exactly one
  // definition of where this file lives (src/config.ts envPath()).
  const { envPath } = await import("../dist/config.js");
  return envPath();
}

async function readEnvText() {
  try {
    return await fs.readFile(await envFilePath(), "utf8");
  } catch {
    return ""; // absent is normal on a first run
  }
}

export function openSettings(parent) {
  if (win && !win.isDestroyed()) {
    win.focus();
    return win;
  }
  const host = parent && !parent.isDestroyed() ? parent : null;
  const W = 620;
  const H = 640;
  // Anchored to the right edge of the window it belongs to, so it reads as a
  // panel sliding in from that edge (settings.html animates the content in from
  // the right) rather than a dialog landing in the middle of the screen.
  let pos = {};
  if (host) {
    const b = host.getBounds();
    pos = {
      x: Math.round(b.x + b.width - W - 24),
      y: Math.round(b.y + Math.max(24, (b.height - H) / 2)),
    };
  }
  win = new BrowserWindow({
    width: W,
    height: H,
    ...pos,
    parent: host ?? undefined,
    backgroundColor: "#0d0d12",
    title: "Gnosis — Settings",
    icon: path.join(here, "icon.png"),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => { win = null; });
  void win.loadFile(path.join(here, "settings.html"));
  return win;
}

/** Register the handlers once, at startup. */
export function registerSettingsIpc({ getMainWindow }) {
  ipcMain.handle("settings:load", async () => {
    const env = parseEnv(await readEnvText());
    const keys = {};
    for (const k of KNOWN_KEYS) keys[k] = { set: !!env[k], masked: maskSecret(env[k]) };
    return {
      path: await envFilePath(),
      keys,
      // Everything else in the file, named so the user can see what "left
      // untouched" refers to. Names only — never their values.
      otherKeys: Object.keys(env).filter((k) => !KNOWN_KEYS.includes(k)),
      // resolveApiKey() reads process.env FIRST, so a key in the environment
      // silently wins over anything saved here. Saying so beats the user editing
      // this file three times and wondering why nothing changes.
      envOverride: !!process.env.OPENROUTER_API_KEY,
    };
  });

  ipcMain.handle("settings:save", async (_e, updates) => {
    try {
      const clean = {};
      for (const [k, v] of Object.entries(updates ?? {})) {
        if (!KNOWN_KEYS.includes(k)) throw new Error(`Refusing to write unknown key ${k}.`);
        if (v !== null && typeof v !== "string") throw new Error(`Bad value for ${k}.`);
        clean[k] = v;
      }
      if (!Object.keys(clean).length) return { ok: false, error: "Nothing to save." };

      const file = await envFilePath();
      await fs.mkdir(path.dirname(file), { recursive: true });
      const next = mergeEnv(await readEnvText(), clean);
      // Write-then-rename: a crash mid-write must not leave the user with a
      // truncated file holding every secret they had.
      const tmp = `${file}.tmp-${process.pid}`;
      await fs.writeFile(tmp, next, { encoding: "utf8", mode: 0o600 });
      await fs.rename(tmp, file);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  ipcMain.on("settings:open", () => openSettings(getMainWindow()));
  ipcMain.on("settings:close", () => { if (win && !win.isDestroyed()) win.close(); });
  ipcMain.on("app:relaunch", () => {
    app.relaunch();
    app.quit();
  });
}

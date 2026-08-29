// The settings window and its IPC.
//
// Deliberately a native window rather than a panel in the web UI: the web UI is
// also what `dom serve` exposes on the LAN, and "type your API key here" does not
// belong on a surface reachable from another machine. Only pages loaded from disk
// with our preload can reach these handlers — the window showing the agent UI has
// no preload at all, so nothing served over HTTP can call them.

import { BrowserWindow, ipcMain, app, dialog } from "electron";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv, mergeEnv, maskSecret } from "./env-file.js";
import { SHORTCUTS } from "./shortcuts.js";

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
export function registerSettingsIpc({ getMainWindow, voiceStatus, setVoiceEnabled, getRootDir, envCwd = null, defaultCwd = null }) {
  ipcMain.handle("settings:load", async () => {
    const env = parseEnv(await readEnvText());
    const keys = {};
    for (const k of KNOWN_KEYS) keys[k] = { set: !!env[k], masked: maskSecret(env[k]) };
    let appCwd;
    try {
      const { loadConfig } = await import("../dist/config.js");
      appCwd = (await loadConfig()).appCwd;
    } catch {
      /* unreadable config — the panel shows the live directory instead */
    }
    return {
      path: await envFilePath(),
      keys,
      // Two separate facts, because they disagree in exactly the case worth
      // seeing: `configured` is what the setting says, `active` is where the
      // agent is ACTUALLY working right now. They differ when GNOSIS_CWD was set
      // for this launch, when the configured path has gone missing, or when the
      // setting was changed and the app has not been restarted yet.
      cwd: {
        configured: appCwd ?? null,
        active: getRootDir?.() ?? null,
        // GNOSIS_CWD set by whoever launched the app wins over this setting, the
        // same way an OPENROUTER_API_KEY in the environment beats the saved one.
        // Saying so beats saving a path three times and wondering why the window
        // keeps opening somewhere else. Null when nobody pinned one.
        envPin: envCwd,
        default: defaultCwd,
      },
      // Everything else in the file, named so the user can see what "left
      // untouched" refers to. Names only — never their values.
      otherKeys: Object.keys(env).filter((k) => !KNOWN_KEYS.includes(k)),
      // resolveApiKey() reads process.env FIRST, so a key in the environment
      // silently wins over anything saved here. Saying so beats the user editing
      // this file three times and wondering why nothing changes.
      envOverride: !!process.env.OPENROUTER_API_KEY,
      // Reference only — the accelerators themselves live in shortcuts.js.
      shortcuts: SHORTCUTS.map((x) => ({ keys: x.keys, label: x.label })),
      voice: voiceStatus?.() ?? { enabled: false, wakeWord: false, transcription: false, reason: "unavailable" },
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

  // Voice is a desktop-only capability, so its switch lives in the desktop-only
  // settings window rather than anywhere the served UI could reach.
  ipcMain.handle("settings:set-voice", async (_e, on) => {
    try {
      const { saveConfig } = await import("../dist/config.js");
      await saveConfig({ voiceEnabled: !!on });
      return (await setVoiceEnabled?.(!!on)) ?? { enabled: !!on };
    } catch (e) {
      return { enabled: false, reason: String(e?.message ?? e) };
    }
  });

  // The working directory. Saved to ~/.dom/config.json (appCwd) rather than .env,
  // because it is a preference and not a secret — and because the CLI reads that
  // same file, so the key sits beside the model and mode it belongs with.
  //
  // Takes effect on restart, and says so rather than pretending otherwise: the
  // engine, the repo map and the file tree are all built from cwd at boot, so
  // moving a live agent to a different root would leave three caches describing a
  // directory it is no longer in.
  ipcMain.handle("settings:set-app-cwd", async (_e, dir) => {
    try {
      const raw = String(dir ?? "").trim();
      const { saveConfig } = await import("../dist/config.js");
      // Empty clears the setting and returns the app to its default.
      if (!raw) {
        await saveConfig({ appCwd: undefined });
        return { ok: true, cleared: true };
      }
      const abs = path.resolve(raw);
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        return { ok: false, error: `No such directory: ${abs}` };
      }
      if (!stat.isDirectory()) return { ok: false, error: `Not a directory: ${abs}` };
      await saveConfig({ appCwd: abs });
      return { ok: true, path: abs };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  // A native folder picker, because typing an absolute path by hand is how you
  // get a typo saved as a setting and a window that opens somewhere unexpected.
  ipcMain.handle("settings:pick-app-cwd", async () => {
    const parent = win && !win.isDestroyed() ? win : getMainWindow?.();
    const r = await dialog.showOpenDialog(parent ?? undefined, {
      title: "Working directory",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: getRootDir?.() ?? undefined,
    });
    if (r.canceled || !r.filePaths?.length) return { ok: false, canceled: true };
    return { ok: true, path: r.filePaths[0] };
  });

  ipcMain.handle("settings:set-voice-name", async (_e, name) => {
    try {
      const { saveConfig } = await import("../dist/config.js");
      await saveConfig({ kokoroVoice: String(name ?? "") });
      return { ok: true, voice: name };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  ipcMain.on("settings:open", () => openSettings(getMainWindow()));
  ipcMain.on("settings:close", () => { if (win && !win.isDestroyed()) win.close(); });
  ipcMain.on("app:relaunch", () => {
    app.relaunch();
    app.quit();
  });
}

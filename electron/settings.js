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

/**
 * The keys this panel always shows, whether or not they are set, because the app
 * does not work without the first and the web-search tool does not exist without
 * the second. Everything else in .env is listed too, but only once it exists.
 *
 * These are PINNED, not an allowlist. The panel used to refuse to write anything
 * outside this pair, which meant GROQ_API_KEY — already in the file, already used
 * by transcription — was visible as "1 other entry … left untouched" and editable
 * nowhere. Any key the user wants is now editable; the guard moved from "which
 * names" to "what a name may look like".
 */
const PINNED_KEYS = [
  { name: "OPENROUTER_API_KEY", note: "Required. Gnosis reaches every model through OpenRouter.", placeholder: "sk-or-v1-…" },
  { name: "BRAVE_API_KEY", note: "Optional. Enables the web-search tool.", placeholder: "brv-…" },
];

/** Notes for keys we happen to recognise. Purely informational — a key not listed
 * here is still perfectly editable, it just gets no caption. */
const KEY_NOTES = {
  GROQ_API_KEY: "Speech-to-text for the voice session, and Groq-hosted models.",
  CONTEXT7_API_KEY: "Context7 MCP — higher documentation rate limits.",
};

/**
 * What a name is allowed to look like. The renderer names the key to write, so
 * without a guard an injected page could set PATH, NODE_OPTIONS or
 * ELECTRON_RUN_AS_NODE and turn a settings dialog into code execution the next
 * time anything reads this file. Screaming snake case only: no lowercase, no
 * dots, no dashes, no whitespace, and it may not begin with a digit.
 */
const KEY_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const MAX_KEY_NAME = 96;

/** Throw unless `name` is a legal env key. Used by both save and rename, so the
 * two cannot drift apart into one being stricter than the other. */
function assertKeyName(name) {
  const k = String(name ?? "");
  if (!k) throw new Error("A key needs a name.");
  if (k.length > MAX_KEY_NAME) throw new Error(`Key name is too long (max ${MAX_KEY_NAME}).`);
  if (!KEY_NAME_RE.test(k)) {
    throw new Error(`"${k}" is not a valid key name — use A–Z, 0–9 and underscores, starting with a letter.`);
  }
  return k;
}

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

/**
 * Apply `updates` (string sets the key, null deletes it) to ~/.dom/.env.
 *
 * Write-then-rename, because a crash mid-write must not leave the user with a
 * truncated file holding every secret they had. Mode 0600 on the temp file, so
 * the secrets are never briefly world-readable even for the moment it exists.
 */
async function writeEnv(updates) {
  const file = await envFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const next = mergeEnv(await readEnvText(), updates);
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, next, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
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
export function registerSettingsIpc({ getMainWindow, voiceStatus, setVoiceEnabled, setWakeEngine, getRootDir, envCwd = null, defaultCwd = null }) {
  ipcMain.handle("settings:load", async () => {
    const env = parseEnv(await readEnvText());
    // One ordered list: the pinned pair first so the required key is never below
    // the fold, then everything else in the file alphabetically. Values never
    // leave the main process — only whether a key is set, and a mask of it.
    const pinned = new Set(PINNED_KEYS.map((k) => k.name));
    const keys = [
      ...PINNED_KEYS.map((k) => ({
        name: k.name,
        pinned: true,
        note: k.note,
        placeholder: k.placeholder,
        set: !!env[k.name],
        masked: maskSecret(env[k.name]),
      })),
      ...Object.keys(env)
        .filter((k) => !pinned.has(k))
        .sort()
        .map((k) => ({
          name: k,
          pinned: false,
          note: KEY_NOTES[k] ?? "",
          placeholder: "",
          set: true,
          masked: maskSecret(env[k]),
        })),
    ];
    let appCwd, wakeEngine;
    try {
      const { loadConfig } = await import("../dist/config.js");
      const cfg = await loadConfig();
      appCwd = cfg.appCwd;
      wakeEngine = cfg.wakeEngine === "whisper" ? "whisper" : "openwakeword";
    } catch {
      /* unreadable config — the panel shows the live directory instead */
      wakeEngine = "openwakeword";
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
      // Kept for anything still reading the old shape; `keys` above now covers
      // these properly, with an editor each rather than a sentence about them.
      otherKeys: Object.keys(env).filter((k) => !pinned.has(k)),
      // resolveApiKey() reads process.env FIRST, so a key in the environment
      // silently wins over anything saved here. Saying so beats the user editing
      // this file three times and wondering why nothing changes.
      envOverride: !!process.env.OPENROUTER_API_KEY,
      // Reference only — the accelerators themselves live in shortcuts.js.
      shortcuts: SHORTCUTS.map((x) => ({ keys: x.keys, label: x.label })),
      voice: voiceStatus?.() ?? { enabled: false, wakeWord: false, transcription: false, reason: "unavailable" },
      // Which wake path is selected, independent of `voice` above — voice is
      // live runtime status, this is the saved preference, and they can
      // disagree until a restart-or-relive-switch has happened.
      wakeEngine,
    };
  });

  ipcMain.handle("settings:save", async (_e, updates) => {
    try {
      const clean = {};
      for (const [k, v] of Object.entries(updates ?? {})) {
        assertKeyName(k);
        if (v !== null && typeof v !== "string") throw new Error(`Bad value for ${k}.`);
        clean[k] = v;
      }
      if (!Object.keys(clean).length) return { ok: false, error: "Nothing to save." };
      await writeEnv(clean);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  /**
   * Rename a key, keeping its value.
   *
   * This has to happen in the main process, not the renderer, for the same reason
   * the panel never receives a value: renaming from the page would mean reading
   * the secret out, deleting the old line and writing it back — putting the key
   * on a surface that has no business holding it. Here it is one merge: old set
   * to null, new set to the value that was already on disk.
   */
  ipcMain.handle("settings:rename-key", async (_e, from, to) => {
    try {
      const oldName = assertKeyName(from);
      const newName = assertKeyName(to);
      if (oldName === newName) return { ok: true, unchanged: true };
      const env = parseEnv(await readEnvText());
      if (!(oldName in env)) return { ok: false, error: `${oldName} is not in this file.` };
      // Refused rather than merged: silently overwriting a key the user cannot
      // see the value of is a good way to lose a working credential.
      if (newName in env) return { ok: false, error: `${newName} already exists — delete it first.` };
      await writeEnv({ [oldName]: null, [newName]: env[oldName] });
      return { ok: true, name: newName };
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

  // Which wake path is active: openWakeWord's trained "hey jarvis" detector, or
  // sending short mic chunks to Groq Whisper and matching "hey gnosis" on the
  // transcript (see electron/voice.js for why there is no trained detector for
  // that phrase). Saved immediately, and — unlike appCwd, which needs a
  // restart because the engine, repo map and file tree are all built from cwd
  // at boot — applied live: if voice is currently on, the caller restarts the
  // pipeline so a toggle here takes effect without relaunching the app.
  ipcMain.handle("settings:set-wake-engine", async (_e, engine) => {
    try {
      const eng = engine === "whisper" ? "whisper" : "openwakeword";
      const { saveConfig } = await import("../dist/config.js");
      await saveConfig({ wakeEngine: eng });
      const status = await setWakeEngine?.(eng);
      return { ok: true, engine: eng, voice: status ?? null };
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

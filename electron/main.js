// Desktop shell: the Gnosis web UI in a native window.
//
// This is NOT a second implementation of the UI. The main process boots the same
// engine, the same AppBridge and the same HTTP server that `dom serve` starts,
// then points a BrowserWindow at the token-gated URL instead of printing it. The
// renderer is the identical single-file bundle a browser gets, so anything that
// works in `dom serve` works here by construction — and a bug fixed in one is
// fixed in both.
//
// What lives here is only what a browser tab genuinely cannot do: window chrome,
// the tray, OS notifications, native menus, protocol handling, auto-update, and
// reaching other applications on the machine.

import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTray } from "./tray.js";
import { openSettings, registerSettingsIpc } from "./settings.js";
import { restoredBounds, track, getUiState, setUiState } from "./window-state.js";
import { registerShortcuts } from "./shortcuts.js";
import { registerNotifications } from "./notifications.js";
import { registerDeepLinks } from "./deeplinks.js";
import { registerUpdater } from "./updater.js";
import { registerContextMenus } from "./context-menus.js";
import { registerWin32Focus } from "./win32-focus.js";
import { registerVoice } from "./voice.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The directory the root agent works in.
 *
 * A packaged app is launched from a shortcut, where process.cwd() is wherever
 * Explorer happened to be (often system32) — never a project. The home directory
 * is not the answer either: pointing a repo-indexing agent at all of ~ makes
 * boot() take minutes. So packaged runs start in ~/Gnosis, the workspace root
 * this project already defines (src/workspace.ts) for exactly this "no project
 * to belong to" case: visible, outside every repo, and small. In dev the cwd IS
 * the project, so keep it. GNOSIS_CWD overrides both. */
async function rootCwd() {
  if (process.env.GNOSIS_CWD) return path.resolve(process.env.GNOSIS_CWD);
  if (!app.isPackaged) return process.cwd();
  const { gnosisDir } = await import("../dist/workspace.js");
  const dir = gnosisDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Boot the agent and its server. Port 0 (ephemeral) rather than 7777: the
 * desktop app must not fight a `dom serve` the user already has running, and
 * nothing here needs a fixed port — the URL goes straight to the window. */
async function startGnosis(cwd) {
  const { boot } = await import("../dist/startup.js");
  const { createBridge, EventBus } = await import("../dist/events.js");
  const { startServer } = await import("../dist/server.js");
  const { wireServeHost } = await import("../dist/servehost.js");

  const { engine } = await boot(
    {
      headless: false,
      yolo: false,
      resumeLatest: false,
      help: false,
      version: false,
      noAutoCommit: false,
      print: false,
      save: false,
      json: false,
      serve: true,
    },
    cwd,
  );

  const bridge = createBridge(new EventBus());
  const server = await startServer(bridge, { port: 0 });
  // Wire BEFORE the window loads the URL, for the same reason cli.tsx wires
  // before printing it: the server is already listening, and a renderer that
  // connects first would get an opening snapshot with an empty agent roster.
  wireServeHost(engine, bridge);
  return { server, bridge, engine };
}

function createWindow() {
  return new BrowserWindow({
    ...restoredBounds(),
    minWidth: 900,
    minHeight: 600,
    // The UI is dark; painting the frame dark too avoids a white flash on open.
    backgroundColor: "#0d0d12",
    title: "Gnosis",
    icon: path.join(here, "icon.png"),
    show: false,
    autoHideMenuBar: true,
    // The UI draws its own title bar (web/src/TopBar.tsx) so the window can be
    // one continuous clay surface instead of the app hanging below an OS strip.
    frame: false,
    backgroundMaterial: "acrylic",
    webPreferences: {
      // The renderer is ordinary web content talking to localhost over HTTP.
      // It has never needed Node, so it does not get Node — only the shell
      // bridge, which is the narrowest surface that can draw a title bar.
      preload: path.join(here, "shell-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
}

/** The title-bar buttons the renderer draws, plus the UI state it asks us to
 * remember for it. Kept next to the window they act on. */
function registerWindowChrome(getWin) {
  const on = (channel, fn) =>
    ipcMain.on(channel, () => {
      const w = getWin();
      if (w && !w.isDestroyed()) fn(w);
    });
  on("win:minimize", (w) => w.minimize());
  on("win:toggle-maximize", (w) => (w.isMaximized() ? w.unmaximize() : w.maximize()));
  // Close means "close to tray" here, exactly like the frame button it replaces.
  on("win:close", (w) => w.close());
  ipcMain.handle("win:is-maximized", () => {
    const w = getWin();
    return !!w && !w.isDestroyed() && w.isMaximized();
  });
  // Renderer state that outlives the ephemeral port its localStorage is keyed to.
  ipcMain.handle("ui:get", () => getUiState());
  ipcMain.on("ui:set", (_e, patch) => setUiState(patch));
}

// One agent per machine. A second launch would boot a second engine against the
// same ~/.dom session state; focus the live window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let server = null;
  let tray = null;
  let win = null;
  let voice = null;
  let rootDir = process.cwd();
  // Closing the window hides to the tray; only an explicit Quit really exits.
  // Without this the tray's whole point evaporates — an agent working in the
  // background is exactly when you want the window out of the way.
  let quitting = false;

  const showWindow = () => {
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  };

  /** Hand an action to the renderer, showing the window first — every one of
   * these is something the user expects to SEE happen. */
  const toRenderer = (channel, payload) => {
    if (!win || win.isDestroyed()) return;
    showWindow();
    win.webContents.send(channel, payload);
  };

  app.on("second-instance", showWindow);

  const deepLinks = registerDeepLinks((action) => toRenderer("deeplink", action));

  app.whenReady().then(async () => {
    win = createWindow();
    track(win);
    win.once("ready-to-show", () => win.show());
    // Links to the outside world belong in the user's real browser, not in a
    // window that has no address bar to escape from.
    win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: "deny" };
    });
    for (const ev of ["maximize", "unmaximize"]) {
      win.on(ev, () => win.webContents.send("win:maximized", win.isMaximized()));
    }
    win.on("close", (e) => {
      if (quitting) return;
      e.preventDefault();
      win.hide();
    });
    // Paint something before boot: starting the engine is not instant, and a
    // window that stays invisible until it finishes looks like a failed launch.
    await win.loadFile(path.join(here, "loading.html"));
    win.show();

    let bridge = null;
    let bootFailed = false;
    try {
      rootDir = await rootCwd();
      const started = await startGnosis(rootDir);
      server = started.server;
      bridge = started.bridge;
      await win.loadURL(server.url);
    } catch (e) {
      // The common case is a missing OpenRouter key, which boot() reports as a
      // BootError carrying the exact instructions. Show those rather than dying
      // silently on a blank window; the settings window opens over it below.
      await win.loadFile(path.join(here, "boot-error.html"), {
        search: `?message=${encodeURIComponent(e?.message ?? String(e))}`,
      });
      win.show();
      bootFailed = true;
    }

    // Electron denies getUserMedia unless something approves it, and the denial
    // is silent — which is exactly how a wake word "just does nothing". Grant
    // media only, and only to pages loaded from disk (the voice windows); the
    // served UI is never on file:// so it can never reach this.
    const grantMedia = (webContents, permission) => {
      if (permission !== "media") return false;
      const url = webContents.getURL();
      return url.startsWith("file://");
    };
    win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
      callback(grantMedia(wc, permission));
    });
    win.webContents.session.setPermissionCheckHandler((wc, permission) => (wc ? grantMedia(wc, permission) : false));

    registerSettingsIpc({
      getMainWindow: () => win,
      voiceStatus: () => voice?.status() ?? null,
      setVoiceEnabled: (on) => (on ? voice?.start() : (voice?.stop(), voice?.status())),
    });
    registerWindowChrome(() => win);
    registerContextMenus({ getRoot: () => rootDir });
    registerWin32Focus();
    registerUpdater(() => win);
    registerShortcuts({
      send: (action) => toRenderer("shortcut", action),
      onSettings: () => openSettings(win),
    });

    tray = createTray(bridge?.bus ?? null, {
      onShow: showWindow,
      onSettings: () => openSettings(win),
      onQuit: () => app.quit(),
    });

    // Toasts while the window is not focused; clicking one brings you to the
    // agent that raised it.
    registerNotifications(bridge?.bus ?? null, {
      onActivate: (payload) => toRenderer("notification-activate", payload),
    });

    // Voice is desktop-only by construction: it lives in the main process and
    // is never exposed to the served page.
    voice = registerVoice({
      getWindow: () => win,
      showWindow,
      setListening: (on) => tray?.setListening(on),
      bridge,
    });

    // A failed boot is almost always a missing key. Put the one window that can
    // fix it on screen rather than making the user find it in the tray menu.
    if (bootFailed) openSettings(win);

    // A gnosis:// link that launched us cold: the renderer has to exist first.
    if (deepLinks.pending) {
      win.webContents.once("did-finish-load", () => deepLinks.route(deepLinks.pending));
    }

    // The shell's composition root, hung on `app` so the pieces that come later
    // have one place to reach for them instead of re-deriving state.
    app.gnosis = { tray, bridge, server, showWindow, voice, rootDir };
  });

  // The window is hidden, not closed, so this fires only after a real quit has
  // already begun. Kept as a backstop for a destroyed-window edge case.
  app.on("window-all-closed", () => {
    if (quitting) return;
  });

  app.on("before-quit", () => {
    quitting = true;
    voice?.stop();
    tray?.destroy();
    // Ends the session: stops the HTTP/WS server and reaps every live pty.
    void server?.close();
  });
}

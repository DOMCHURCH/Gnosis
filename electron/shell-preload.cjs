// Preload for the main window — the one showing the agent UI.
//
// Scope is deliberately narrow. That window loads its page over HTTP from the
// local server, and the same bundle is served to LAN browsers, so anything
// exposed here is reachable from the app's most exposed surface. It gets window
// chrome, the shell's own events, and menu/UI-state plumbing. It does NOT get
// settings, key access, file I/O, or the microphone — those live behind windows
// loaded from disk (settings.html, voice-*.html) with their own preloads.
//
// Its presence is also the signal the UI uses to know it is running in the
// desktop shell rather than a browser tab.
const { contextBridge, ipcRenderer } = require("electron");

/** Subscribe helper that hands back an unsubscribe, so React effects can clean up. */
const on = (channel, cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.off(channel, h);
};

contextBridge.exposeInMainWorld("gnosisShell", {
  platform: process.platform,

  // --- window chrome ---
  minimize: () => ipcRenderer.send("win:minimize"),
  toggleMaximize: () => ipcRenderer.send("win:toggle-maximize"),
  close: () => ipcRenderer.send("win:close"),
  openSettings: () => ipcRenderer.send("settings:open"),
  isMaximized: () => ipcRenderer.invoke("win:is-maximized"),
  onMaximizeChange: (cb) => on("win:maximized", cb),

  // --- UI state that must outlive the ephemeral port ---
  getUiState: () => ipcRenderer.invoke("ui:get"),
  setUiState: (patch) => ipcRenderer.send("ui:set", patch),

  // --- native context menus ---
  showMenu: (kind, payload) => ipcRenderer.send("menu:show", { kind, payload }),
  onMenuCommand: (cb) => on("menu:command", cb),

  // --- shortcuts, deep links, notifications ---
  onShortcut: (cb) => on("shortcut", cb),
  onDeepLink: (cb) => on("deeplink", cb),
  onNotificationActivate: (cb) => on("notification-activate", cb),

  // --- updates (check-and-tell only; see electron/updater.js for why) ---
  onUpdateAvailable: (cb) => on("update:available", cb),
  // Nothing is downloaded or staged any more, so there is no "ready" event and
  // nothing to restart into. This opens the releases page and the user installs
  // deliberately.
  openReleasesPage: () => ipcRenderer.send("update:open-releases"),
  checkForUpdate: () => ipcRenderer.invoke("update:check"),

  // --- voice (desktop only; the served page in a browser has none of this) ---
  voiceStatus: () => ipcRenderer.invoke("voice:status"),
  speak: (text) => ipcRenderer.invoke("voice:speak", text),

  // --- reaching other applications ---
  focusWindow: (arg) => ipcRenderer.invoke("force-focus-window", arg),
  runningApps: () => ipcRenderer.invoke("get-running-apps"),
});

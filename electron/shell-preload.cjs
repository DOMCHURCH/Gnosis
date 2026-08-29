// Preload for the main window — the one showing the agent UI.
//
// Scope is deliberately tiny. That window loads its page over HTTP from the
// local server, and the same bundle is served to LAN browsers, so anything
// exposed here is reachable from the app's most exposed surface. It therefore
// gets window chrome and nothing else: no settings, no key access, no file I/O.
// The worst a compromised page could do with this is minimise the window.
//
// Its presence is also the signal the UI uses to know it is running in the
// desktop shell rather than a browser tab, so it can draw its own title bar.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gnosisShell", {
  platform: process.platform,
  minimize: () => ipcRenderer.send("win:minimize"),
  toggleMaximize: () => ipcRenderer.send("win:toggle-maximize"),
  close: () => ipcRenderer.send("win:close"),
  openSettings: () => ipcRenderer.send("settings:open"),
  isMaximized: () => ipcRenderer.invoke("win:is-maximized"),
  /** Fires on maximize/unmaximize so the control can redraw. */
  onMaximizeChange: (cb) => {
    const h = (_e, v) => cb(v);
    ipcRenderer.on("win:maximized", h);
    return () => ipcRenderer.off("win:maximized", h);
  },
});

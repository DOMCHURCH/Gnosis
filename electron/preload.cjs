// Preload for the shell's own pages (settings, boot error).
//
// .cjs, not .js: the package is type:module, and Electron loads preloads as
// CommonJS — the extension is what keeps that unambiguous.
//
// The renderer gets a narrow, named API and nothing else: no ipcRenderer, no
// require, no fs. Secrets never cross this boundary in the readable direction —
// load() returns whether a key is set and a masked hint, never the key itself.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gnosis", {
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (updates) => ipcRenderer.invoke("settings:save", updates),
  renameSettingsKey: (from, to) => ipcRenderer.invoke("settings:rename-key", from, to),
  openSettings: () => ipcRenderer.send("settings:open"),
  relaunch: () => ipcRenderer.send("app:relaunch"),
  closeSettings: () => ipcRenderer.send("settings:close"),
  setVoiceEnabled: (on) => ipcRenderer.invoke("settings:set-voice", on),
  voiceDiagnostics: () => ipcRenderer.invoke("voice:diagnostics"),
  voiceProbe: () => ipcRenderer.invoke("voice:probe-runtime"),
  voiceTest: () => ipcRenderer.invoke("voice:test"),
  /** Install openWakeWord + Kokoro and download their models. Long-running:
   * progress arrives on onVoiceSetupStep, and the promise resolves at the end. */
  voiceSetup: (parts) => ipcRenderer.invoke("voice:setup", parts),
  onVoiceSetupStep: (cb) => ipcRenderer.on("voice:setup-step", (_e, s) => cb(s)),
  setVoiceName: (v) => ipcRenderer.invoke("settings:set-voice-name", v),
  // Working directory: the folder the app opens into. pickAppCwd opens the native
  // directory chooser; setAppCwd saves a path (empty string clears the setting).
  pickAppCwd: () => ipcRenderer.invoke("settings:pick-app-cwd"),
  setAppCwd: (dir) => ipcRenderer.invoke("settings:set-app-cwd", dir),
});

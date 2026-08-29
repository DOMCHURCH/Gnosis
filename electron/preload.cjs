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
  openSettings: () => ipcRenderer.send("settings:open"),
  relaunch: () => ipcRenderer.send("app:relaunch"),
  closeSettings: () => ipcRenderer.send("settings:close"),
  setVoiceEnabled: (on) => ipcRenderer.invoke("settings:set-voice", on),
  voiceDiagnostics: () => ipcRenderer.invoke("voice:diagnostics"),
  voiceProbe: () => ipcRenderer.invoke("voice:probe-runtime"),
  voiceTest: () => ipcRenderer.invoke("voice:test"),
  setVoiceName: (v) => ipcRenderer.invoke("settings:set-voice-name", v),
});

// Preload for the hidden camera window. One capability, nothing else: take a
// frame when asked and hand it back. No fs, no ipcRenderer, no require.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("camera", {
  ready: () => ipcRenderer.send("camera:ready"),
  onCapture: (cb) => ipcRenderer.on("camera:capture", (_e, id) => cb(id)),
  frame: (id, payload) => ipcRenderer.send("camera:frame", { id, payload }),
});

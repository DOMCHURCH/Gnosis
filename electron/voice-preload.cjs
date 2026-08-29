// Preload for the two voice renderers: the hidden microphone engine and the
// visible overlay. Both are local files loaded from disk, never the served page,
// so this bridge is not reachable from anything that comes over HTTP.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voice", {
  // engine -> main
  wake: () => ipcRenderer.send("voice:wake"),
  utterance: (wavBase64) => ipcRenderer.send("voice:utterance", wavBase64),
  /** Continuous 16 kHz mono PCM for the wake-word detector. */
  audio: (pcmBuffer) => ipcRenderer.send("voice:audio", pcmBuffer),
  cancel: () => ipcRenderer.send("voice:cancel"),
  engineStatus: (s) => ipcRenderer.send("voice:engine-status", s),
  // main -> engine
  onConfigure: (cb) => ipcRenderer.on("voice:configure", (_e, cfg) => cb(cfg)),
  onRecord: (cb) => ipcRenderer.on("voice:record", () => cb()),
  // main -> overlay
  onState: (cb) => ipcRenderer.on("voice:state", (_e, s) => cb(s)),
});

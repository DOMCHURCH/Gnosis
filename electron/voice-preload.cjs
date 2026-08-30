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
  /** Live input level, for the settings meter. */
  level: (v) => ipcRenderer.send("voice:level", v),
  /** Whether the microphone actually opened, and why not when it did not. */
  mic: (s) => ipcRenderer.send("voice:mic", s),
  onPlay: (cb) => ipcRenderer.on("voice:play", (_e, file) => cb(file)),
  /** Playback of one clip finished — the signal the session waits for before
   * reopening the microphone, so it never hears the tail of its own reply. */
  playDone: () => ipcRenderer.send("voice:play-done"),
  /** Stop the current clip immediately (the overlay was closed). */
  onStopAudio: (cb) => ipcRenderer.on("voice:stop-audio", () => cb()),
  /** Mute the microphone while we are talking, to kill the echo loop. */
  onMute: (cb) => ipcRenderer.on("voice:mute", (_e, m) => cb(!!m?.on)),
  cancel: () => ipcRenderer.send("voice:cancel"),
  engineStatus: (s) => ipcRenderer.send("voice:engine-status", s),
  // main -> engine
  onConfigure: (cb) => ipcRenderer.on("voice:configure", (_e, cfg) => cb(cfg)),
  onRecord: (cb) => ipcRenderer.on("voice:record", () => cb()),
  // main -> overlay
  onState: (cb) => ipcRenderer.on("voice:state", (_e, s) => cb(s)),
  /** Live input level for the overlay's waveform — the same measurement the
   * settings meter reads, forwarded rather than re-captured. */
  onLevel: (cb) => ipcRenderer.on("voice:level-out", (_e, v) => cb(v)),
  /** The overlay's × — ends the whole session, not just this turn. */
  endSession: () => ipcRenderer.send("voice:end-session"),
});

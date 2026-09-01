// Preload for the overlay render probe — a recording stand-in for the real
// electron/voice-preload.cjs bridge.
//
// It exists because the probe was rendering the overlay with NO preload at all,
// so `window.voice` was undefined and the page's own script threw at the first
// `window.voice.onState(...)`. Everything registered after that line never ran:
// the permission pane was never rendered, the tab handlers were never wired, and
// the button behaviour the requirements ask about could not be exercised. The
// geometry assertions still passed, which is exactly why this was invisible.
//
// Same surface as the real bridge, same names, but every main-process call is
// recorded instead of sent. The probe reads them back to check WHICH action a
// control performs — a screenshot cannot show that × ends the conversation while
// the crossed microphone turns voice off.
const { contextBridge } = require("electron");

const calls = [];
const rec = (name) => (...args) => { calls.push({ name, args: args.map((a) => (typeof a === "object" ? "[obj]" : a)) }); };
// The main->renderer subscriptions have to be real functions that accept a
// callback and do nothing; the page calls each one exactly once at startup.
const sub = () => (_cb) => {};

contextBridge.exposeInMainWorld("voice", {
  endSession: rec("endSession"),
  stopVoice: rec("stopVoice"),
  resize: rec("resize"),
  answerPermission: rec("answerPermission"),
  onState: sub(),
  onLevel: sub(),
  onIdle: sub(),
  onPermissions: sub(),
});

contextBridge.exposeInMainWorld("__probe", {
  calls: () => calls.map((c) => c.name),
  detail: () => calls.map((c) => ({ ...c })),
  clear: () => { calls.length = 0; },
});

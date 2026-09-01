// Which of four things the microphone button is currently saying.
//
// Extracted from TopBar.tsx and kept as plain JS with a .d.ts beside it — the
// same shape as chatgroups/sessions/kanban — because it is the part with real
// decisions in it and a component is a bad place to test a decision.
//
// The state that matters most is "broken": voice enabled, but the wake word or
// the transcriber is not actually up. That was previously invisible — the user
// asked for voice, did not get it, and the window looked identical to one where
// everything worked. It is deliberately NOT drawn as "off", because off is a
// choice and this is a failure.

/**
 * @param {{enabled:boolean,wakeWord:boolean,transcription:boolean,reason:string,session?:boolean}|null} v
 * @returns {{state:string,label:string,fg:string,bg:string,bd:string,title:string,action:string}|null}
 */
export function voiceLook(v) {
  if (!v) return null;

  const broken = v.enabled && (!v.wakeWord || !v.transcription);
  const state = v.session ? "listening" : broken ? "broken" : v.enabled ? "on" : "off";

  const LOOK = {
    listening: { label: "LISTENING", fg: "#34d399", bg: "rgba(52,211,153,0.14)", bd: "rgba(52,211,153,0.42)" },
    on: { label: "VOICE", fg: "#22d3ee", bg: "rgba(34,211,238,0.10)", bd: "rgba(34,211,238,0.30)" },
    broken: { label: "VOICE", fg: "#FBBF24", bg: "rgba(251,191,36,0.12)", bd: "rgba(251,191,36,0.30)" },
    off: { label: "VOICE OFF", fg: "#6B6B7B", bg: "transparent", bd: "rgba(255,255,255,0.09)" },
  }[state];

  // The tooltip is the only place a failure gets to explain itself, so the
  // broken one carries the reason the main process gave rather than a generic
  // "voice unavailable".
  const title =
    state === "listening" ? "Listening — click to end the conversation"
    : state === "broken" ? `Voice is on but cannot hear: ${v.reason || "unavailable"}. Open Settings → Voice to fix it.`
    : state === "on" ? "Start talking — or just say “hey jarvis”"
    : "Voice is off. Click to turn it on and listen for “hey jarvis”.";

  // What a click does. Named rather than inferred at the call site so the button
  // and this table cannot drift apart.
  const action =
    state === "off" ? "enable"
    : state === "broken" ? "settings"
    : "wake";

  return { state, title, action, ...LOOK };
}

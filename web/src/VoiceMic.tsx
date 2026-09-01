// The microphone control, in the two places it belongs.
//
// Voice had no presence in this window at all: the wake word is invisible until
// it fires, the overlay does not exist until a conversation has started, and the
// only control was a switch inside Settings. A feature you cannot see is one
// nobody uses — and one whose failures are silent, because a missing Python or
// transcription key looked identical to a working install.
//
// Two placements, one component, because two copies of this would drift:
//
//   "bar"       the title bar — always visible, says what state voice is in
//   "composer"  beside the message box — where you are already looking when you
//               want to say something, and the reason you should not have to
//               remember a wake phrase to start
//
// All the decisions live in voicestate.js so they can be tested without
// rendering anything; this file is the button around them.
import { useEffect, useState, type CSSProperties } from "react";
import { shellBridge } from "./TopBar";
import { voiceLook } from "./voicestate";
import type { VoiceState } from "./voicestate";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

export function VoiceMic({ variant }: { variant: "bar" | "composer" }) {
  const shell = shellBridge();
  const [v, setV] = useState<VoiceState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!shell?.voiceStatus) return;
    let alive = true;
    void shell.voiceStatus().then((s) => { if (alive) setV(s); }).catch(() => {});
    // Pushed by the main process, not polled: it knows when this changes.
    const off = shell.onVoiceStatus?.((s) => { if (alive) setV(s); });
    return () => { alive = false; off?.(); };
  }, [shell]);

  // A browser tab or a phone on the LAN has no shell bridge and no microphone —
  // rendering a dead button there would be a worse lie than rendering nothing.
  if (!shell?.voiceStatus) return null;
  const look = voiceLook(v);
  if (!look) return null;

  async function click() {
    if (busy || !shell) return;
    setBusy(true);
    try {
      if (look!.action === "enable") setV(await shell.voiceSetEnabled(true));
      else if (look!.action === "settings") shell.openSettings();
      else shell.voiceWake();
    } catch { /* the tooltip already says what is wrong */ } finally { setBusy(false); }
  }

  const icon = (
    <svg width={variant === "bar" ? 11 : 14} height={variant === "bar" ? 11 : 14} viewBox="0 0 24 24"
         fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 2a3 3 0 013 3v6a3 3 0 01-6 0V5a3 3 0 013-3z" />
      <path d="M5 11a7 7 0 0014 0M12 18v3" />
      {look.state === "off" && <path d="M4 3l16 18" />}
    </svg>
  );

  // Beside the message box the label would crowd the input, and the row already
  // has the paperclip setting the visual language: an icon, no text. The state
  // still reads, through colour and through the crossed-out mic when off.
  const style: CSSProperties = variant === "bar"
    ? {
        WebkitAppRegion: "no-drag",
        display: "flex", alignItems: "center", gap: 6,
        fontFamily: MONO, fontSize: 9, letterSpacing: 1.5,
        padding: "4px 11px", borderRadius: 999,
        background: look.bg, color: look.fg, border: `1px solid ${look.bd}`,
        cursor: busy ? "default" : "pointer", whiteSpace: "nowrap", opacity: busy ? 0.6 : 1,
      } as CSSProperties
    : {
        display: "grid", placeItems: "center",
        width: 26, height: 26, borderRadius: 8, padding: 0,
        background: look.state === "off" ? "transparent" : look.bg,
        color: look.fg,
        border: `1px solid ${look.state === "off" ? "transparent" : look.bd}`,
        cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1,
      };

  return (
    <button
      type="button"
      data-testid={variant === "bar" ? "voice-button" : "voice-mic-composer"}
      title={look.title}
      aria-label={look.title}
      aria-pressed={!!v?.enabled}
      onClick={click}
      style={style}
    >
      {icon}
      {variant === "bar" && look.label}
    </button>
  );
}

export interface VoiceState {
  enabled: boolean;
  wakeWord: boolean;
  transcription: boolean;
  reason: string;
  /** True while a conversation is open — the overlay is up and listening. */
  session?: boolean;
}

export interface VoiceLook {
  state: "listening" | "on" | "broken" | "off";
  label: string;
  fg: string;
  bg: string;
  bd: string;
  title: string;
  action: "enable" | "settings" | "wake";
}

export function voiceLook(v: VoiceState | null): VoiceLook | null;

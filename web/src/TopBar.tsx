// The desktop shell's title bar.
//
// Rendered ONLY when running inside the Electron shell — `window.gnosisShell` is
// injected by electron/shell-preload.cjs, so a browser tab (or a phone on the
// LAN) never sees it and keeps the OS/browser chrome it already has. The window
// is frameless there, which means this bar owns dragging and the three window
// buttons: if it fails to render, the window cannot be moved or closed, so it is
// deliberately free of data dependencies that could throw.

import { useEffect, useState, type CSSProperties } from "react";
import { Z } from "./layers";
import { MARK_ROWS } from "./logo.generated";

export interface ShellBridge {
  platform: string;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  openSettings(): void;
  isMaximized(): Promise<boolean>;
  onMaximizeChange(cb: (v: boolean) => void): () => void;

  /** Renderer state that must outlive the ephemeral port localStorage is keyed to. */
  getUiState(): Promise<Record<string, unknown>>;
  setUiState(patch: Record<string, unknown>): void;

  /** Native right-click menus: the renderer says what was clicked, main draws. */
  showMenu(kind: "zone" | "agent" | "file", payload: Record<string, unknown>): void;
  onMenuCommand(cb: (m: { command: string; payload: Record<string, unknown> }) => void): () => void;

  onShortcut(cb: (action: string) => void): () => void;
  onDeepLink(cb: (d: { action: string; name?: string; path?: string }) => void): () => void;
  onNotificationActivate(cb: (p: { tabId?: number; kind?: string }) => void): () => void;

  onUpdateAvailable(cb: (i: { version: string | null; url?: string }) => void): () => void;
  openReleasesPage(): void;
  checkForUpdate(): Promise<{ ok: boolean; version?: string | null; url?: string; error?: string }>;

  voiceStatus(): Promise<VoiceState>;
  speak(text: string): Promise<{ ok: boolean; error?: string }>;
  voiceWake(): void;
  voiceSetEnabled(on: boolean): Promise<VoiceState>;
  onVoiceStatus(cb: (s: VoiceState) => void): () => void;

  focusWindow(arg: { app?: string; pid?: number }): Promise<Record<string, unknown>>;
  runningApps(): Promise<Record<string, unknown>>;
}

/** The shell bridge, or null in a browser. */
export function shellBridge(): ShellBridge | null {
  return (window as unknown as { gnosisShell?: ShellBridge }).gnosisShell ?? null;
}

export interface VoiceState {
  enabled: boolean;
  wakeWord: boolean;
  transcription: boolean;
  reason: string;
  /** True while a conversation is open — the overlay is up and listening. */
  session?: boolean;
}

const MONO = "'JetBrains Mono', ui-monospace, monospace";

/**
 * The microphone, given the room a headline feature deserves.
 *
 * Voice had no presence in this window at all: the wake word is invisible until
 * it fires, the overlay only exists once a conversation has started, and the
 * only control was a switch inside Settings. A feature you cannot see is a
 * feature nobody uses, and one whose failures are silent — no Python, no
 * transcription key, and the app looked identical to a working one.
 *
 * So this is a labelled control rather than a glyph: it says what state voice is
 * in, it starts a conversation on click without needing the wake phrase, and
 * when it cannot work it says why in its tooltip instead of doing nothing.
 */
function VoiceButton({ shell }: { shell: ShellBridge }) {
  const [v, setV] = useState<VoiceState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void shell.voiceStatus().then((s) => { if (alive) setV(s); }).catch(() => {});
    // Pushed, not polled: the main process tells us when it changes.
    const off = shell.onVoiceStatus?.((s) => { if (alive) setV(s); });
    return () => { alive = false; off?.(); };
  }, [shell]);

  if (!v) return null; // a browser tab, or the status has not arrived yet

  // Enabled but not actually able to hear is its own state, and the one that
  // used to be invisible. It looks different from "off" because it is: the user
  // asked for voice and did not get it.
  const broken = v.enabled && (!v.wakeWord || !v.transcription);
  const state = v.session ? "listening" : broken ? "broken" : v.enabled ? "on" : "off";

  const LOOK = {
    listening: { label: "LISTENING", fg: "#34d399", bg: "rgba(52,211,153,0.14)", bd: "rgba(52,211,153,0.42)" },
    on: { label: "VOICE", fg: "#22d3ee", bg: "rgba(34,211,238,0.10)", bd: "rgba(34,211,238,0.30)" },
    broken: { label: "VOICE", fg: "#FBBF24", bg: "rgba(251,191,36,0.12)", bd: "rgba(251,191,36,0.30)" },
    off: { label: "VOICE OFF", fg: "#6B6B7B", bg: "transparent", bd: "rgba(255,255,255,0.09)" },
  }[state];

  const title =
    state === "listening" ? "Listening — click to end the conversation"
    : state === "broken" ? `Voice is on but cannot hear: ${v.reason || "unavailable"}. Settings → Voice to fix it.`
    : state === "on" ? "Start talking — or just say “hey jarvis”"
    : "Voice is off. Click to turn it on and start listening for “hey jarvis”.";

  async function click() {
    if (busy) return;
    setBusy(true);
    try {
      if (state === "off") setV(await shell.voiceSetEnabled(true));
      else if (state === "broken") shell.openSettings();
      else shell.voiceWake();   // starts a conversation, or is ignored if one is open
    } catch { /* the tooltip already says what is wrong */ } finally { setBusy(false); }
  }

  return (
    <button
      type="button"
      data-testid="voice-button"
      title={title}
      aria-label={title}
      aria-pressed={v.enabled}
      onClick={click}
      style={{
        WebkitAppRegion: "no-drag",
        display: "flex", alignItems: "center", gap: 6,
        fontFamily: MONO, fontSize: 9, letterSpacing: 1.5,
        padding: "4px 11px", borderRadius: 999,
        background: LOOK.bg, color: LOOK.fg, border: `1px solid ${LOOK.bd}`,
        cursor: busy ? "default" : "pointer", whiteSpace: "nowrap",
        opacity: busy ? 0.6 : 1,
      } as CSSProperties}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="M12 2a3 3 0 013 3v6a3 3 0 01-6 0V5a3 3 0 013-3z" />
        <path d="M5 11a7 7 0 0014 0M12 18v3" />
        {state === "off" && <path d="M4 3l16 18" />}
      </svg>
      {LOOK.label}
    </button>
  );
}

/** The mark, drawn from the same pixel rows as the Windows icon and the tray. */
function Logo({ size = 32 }: { size?: number }) {
  const rows = MARK_ROWS;
  const w = rows[0].length;
  const h = rows.length;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${w + 2} ${h + 2}`} aria-label="Gnosis" role="img"
      style={{ display: "block", flex: "0 0 auto", filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.55))" }}>
      <defs>
        <radialGradient id="gnosisMark" cx="50%" cy="45%" r="75%">
          <stop offset="0%" stopColor="#2DD9F0" />
          <stop offset="100%" stopColor="#8B1DA8" />
        </radialGradient>
      </defs>
      <rect x="0" y="0" width={w + 2} height={h + 2} rx={(w + 2) * 0.22} fill="url(#gnosisMark)" />
      {rows.flatMap((row, y) =>
        [...row].map((c, x) =>
          c === "#" ? <rect key={`${x}-${y}`} x={x + 1} y={y + 1} width={1} height={1} fill="#F7FAFF" /> : null,
        ),
      )}
    </svg>
  );
}

/**
 * A window control, shaped the way Windows shapes them.
 *
 * These used to be three 13px coloured circles — macOS traffic lights — and the
 * `label` they were passed was never rendered, so what shipped was three dots
 * that gave no clue which one closed the window. On Windows that is not a style
 * choice, it is a control nobody can read: the convention here is a row of wide
 * flat buttons in the top-right corner with an actual glyph in each, and close
 * turning red.
 *
 * Wide and full-height on purpose. A title-bar button is a Fitts's-law target —
 * you throw the pointer at the corner — and a 13px dot with 9px of padding is
 * the opposite of that.
 */
function ControlButton(props: { label: string; onClick: () => void; title: string; danger?: boolean }) {
  const [hot, setHot] = useState(false);
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      onClick={props.onClick}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      style={{
        // Outside the drag region, or the button would move the window instead
        // of being clickable.
        WebkitAppRegion: "no-drag",
        width: 44,
        height: 32,
        padding: 0,
        borderRadius: 0,
        border: 0,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: MONO,
        fontSize: 12,
        lineHeight: 1,
        // Close goes red like every other Windows app; the other two take the
        // neutral wash. Colour here means "this is destructive", not "this is
        // the third one".
        color: hot ? (props.danger ? "#FFFFFF" : "#E4E8EE") : "#8A8A9B",
        background: hot ? (props.danger ? "#C42B1C" : "rgba(255,255,255,0.08)") : "transparent",
        transition: "background-color 150ms ease-out, color 150ms ease-out",
      } as CSSProperties}
    >
      {props.label}
    </button>
  );
}

export function TopBar(props: { shell: ShellBridge; modelId: string | null; costLine: string; awaitingLine: string; awaiting: boolean; globalLine: string }) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    void props.shell.isMaximized().then(setMaximized).catch(() => {});
    return props.shell.onMaximizeChange(setMaximized);
  }, [props.shell]);

  // The model id is long (`anthropic/claude-sonnet-4.5`); the vendor prefix is
  // noise once you know which app you are in.
  const shortModel = props.modelId ? props.modelId.split("/").slice(-1)[0] : null;

  return (
    <div
      data-testid="top-bar"
      style={{
        WebkitAppRegion: "drag",
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: 44,
        zIndex: Z.titleBar,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "0 12px 0 14px",
        fontFamily: MONO,
      } as CSSProperties}
    >
      <Logo size={32} />
      <span
        style={{
          fontSize: 16,
          fontWeight: 700,
          letterSpacing: 3,
          background: "linear-gradient(90deg, #22D3EE, #E879F9)",
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
        }}
      >
        Gnosis
      </span>

      {shortModel && (
        <span
          data-testid="model-pill"
          title={props.modelId ?? undefined}
          style={{
            fontSize: 9,
            letterSpacing: 1.5,
            padding: "4px 11px",
            borderRadius: 999,
            background: "#12121c",
            color: "#22D3EE",
            border: "1px solid rgba(34,211,238,0.22)",
            boxShadow: "0 0 14px -4px rgba(34,211,238,0.5), inset 0 1px 0 rgba(255,255,255,0.05)",
            maxWidth: 260,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {shortModel}
        </span>
      )}

      {props.awaiting && (
        <span style={{ fontSize: 9, letterSpacing: 1.5, padding: "4px 10px", borderRadius: 999, background: "rgba(251,191,36,0.12)", color: "#FBBF24", border: "1px solid rgba(251,191,36,0.22)", whiteSpace: "nowrap" }}>
          {props.awaitingLine}
        </span>
      )}

      <span style={{ flex: "1 1 auto" }} />

      {props.globalLine && (
        <span style={{ fontSize: 9, letterSpacing: 1.5, color: "#6B6B7B", whiteSpace: "nowrap" }}>{props.globalLine}</span>
      )}

      {props.costLine && (
        <span
          data-testid="cost-badge"
          style={{ fontSize: 9, letterSpacing: 1.5, padding: "4px 11px", borderRadius: 999, background: "#12121c", color: "#9aa3b2", border: "1px solid rgba(255,255,255,0.07)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)", whiteSpace: "nowrap" }}
        >
          {props.costLine}
        </span>
      )}

      <VoiceButton shell={props.shell} />

      <button
        type="button"
        title="Settings"
        aria-label="Settings"
        onClick={() => props.shell.openSettings()}
        style={{ WebkitAppRegion: "no-drag", fontFamily: MONO, fontSize: 13, lineHeight: 1, background: "transparent", border: 0, color: "#6B6B7B", cursor: "pointer", padding: "4px 6px" } as CSSProperties}
      >
        ⚙
      </button>

      {/* Flush to the top-right corner with no gaps: that corner is where every
          Windows user throws the pointer, and a gap between the buttons puts a
          dead strip in the middle of the target. The settings gear and the
          session/cost readouts keep their places to the left of this. */}
      <div data-testid="window-controls" style={{ display: "flex", alignItems: "stretch", marginLeft: 8, marginRight: -14, alignSelf: "stretch" }}>
        <ControlButton title="Minimise" label="&#x2500;" onClick={() => props.shell.minimize()} />
        <ControlButton title={maximized ? "Restore" : "Maximise"} label={maximized ? "❐" : "☐"} onClick={() => props.shell.toggleMaximize()} />
        <ControlButton title="Close Gnosis" label="&#x2715;" danger onClick={() => props.shell.close()} />
      </div>
    </div>
  );
}

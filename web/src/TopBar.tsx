// The desktop shell's title bar.
//
// Rendered ONLY when running inside the Electron shell — `window.gnosisShell` is
// injected by electron/shell-preload.cjs, so a browser tab (or a phone on the
// LAN) never sees it and keeps the OS/browser chrome it already has. The window
// is frameless there, which means this bar owns dragging and the three window
// buttons: if it fails to render, the window cannot be moved or closed, so it is
// deliberately free of data dependencies that could throw.

import { useEffect, useState } from "react";
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

  onUpdateReady(cb: (i: { version: string | null }) => void): () => void;
  onUpdateAvailable(cb: (i: { version: string | null }) => void): () => void;
  restartToUpdate(): void;
  checkForUpdate(): Promise<{ ok: boolean; version?: string | null; error?: string }>;

  voiceStatus(): Promise<{ enabled: boolean; wakeWord: boolean; transcription: boolean; reason: string }>;
  speak(text: string): Promise<{ ok: boolean; error?: string }>;

  focusWindow(arg: { app?: string; pid?: number }): Promise<Record<string, unknown>>;
  runningApps(): Promise<Record<string, unknown>>;
}

/** The shell bridge, or null in a browser. */
export function shellBridge(): ShellBridge | null {
  return (window as unknown as { gnosisShell?: ShellBridge }).gnosisShell ?? null;
}

const MONO = "'JetBrains Mono', ui-monospace, monospace";

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
      } as React.CSSProperties}
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
      } as React.CSSProperties}
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

      <button
        type="button"
        title="Settings"
        aria-label="Settings"
        onClick={() => props.shell.openSettings()}
        style={{ WebkitAppRegion: "no-drag", fontFamily: MONO, fontSize: 13, lineHeight: 1, background: "transparent", border: 0, color: "#6B6B7B", cursor: "pointer", padding: "4px 6px" } as React.CSSProperties}
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

import { useEffect, useRef, useState } from "react";
import { Z } from "./layers";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** How the task should be run. The two verbs a phone actually needs. */
export type TaskMode = "code" | "research";

const ACTIONS: { mode: TaskMode; label: string; hint: string; color: string }[] = [
  { mode: "code", label: "CODE IT", hint: "a normal turn — watch it work", color: "#22D3EE" },
  { mode: "research", label: "RESEARCH IT", hint: "read-only — comes back with a summary", color: "#4ADE80" },
];

/**
 * The full-screen task composer for phones. Deliberately not the ordinary chat
 * input: on a phone the useful interaction is "say the thing, choose how it runs,
 * put the phone away", and that wants a big target for each of those steps
 * rather than a one-line field and a send arrow.
 */
export function NewTaskSheet(props: {
  onSubmit: (text: string, mode: TaskMode) => void;
  onClose: () => void;
  /** Ask for notification permission when a background mode is chosen. */
  onWantNotifications?: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Focus so the keyboard opens with the sheet; a phone user should be typing
    // immediately, not tapping again to start.
    const t = setTimeout(() => ref.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);

  const submit = (mode: TaskMode) => {
    const t = text.trim();
    if (!t) return;
    if (mode !== "code") props.onWantNotifications?.();
    props.onSubmit(t, mode);
    props.onClose();
  };

  return (
    // Above the app's view switcher (z 70): a full-screen sheet that something
    // else draws on top of is not full-screen.
    <div style={{ position: "fixed", inset: 0, zIndex: Z.overlay, background: "#0D0D12", display: "flex", flexDirection: "column", fontFamily: MONO }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 14px 10px", borderBottom: "2px solid #2C2C3E" }}>
        <span style={{ fontSize: 12, letterSpacing: 2, color: "#C9C9D6" }}>NEW TASK</span>
        <button
          type="button"
          onClick={props.onClose}
          aria-label="close"
          style={{ marginLeft: "auto", minWidth: 44, minHeight: 44, background: "transparent", border: 0, color: "#6B6B7B", fontSize: 20, fontFamily: MONO, cursor: "pointer" }}
        >
          ×
        </button>
      </div>

      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="what should Gnosis work on?"
        style={{
          flex: 1, minHeight: 0, margin: 14, padding: 12, resize: "none",
          background: "#121219", color: "#C9C9D6", border: "2px solid #2C2C3E",
          fontFamily: MONO, fontSize: 16, lineHeight: 1.5, outline: "none",
        }}
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 14px 18px" }}>
        {ACTIONS.map((a) => (
          <button
            key={a.mode}
            type="button"
            disabled={!text.trim()}
            onClick={() => submit(a.mode)}
            style={{
              display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2,
              // 56px: a comfortable thumb target, matching the bottom nav's height.
              minHeight: 56, padding: "10px 14px", cursor: "pointer",
              background: "#171721", border: `2px solid ${text.trim() ? a.color : "#2C2C3E"}`,
              color: text.trim() ? a.color : "#4A4A58", fontFamily: MONO, textAlign: "left",
              opacity: text.trim() ? 1 : 0.6,
            }}
          >
            <span style={{ fontSize: 12, letterSpacing: 2 }}>{a.label}</span>
            <span style={{ fontSize: 9, letterSpacing: 1, color: "#6B6B7B" }}>{a.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

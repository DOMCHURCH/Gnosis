import { useState } from "react";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

export interface SaveResult { ok: boolean; path?: string; error?: string }

// Prompts for a note filename + tags, then writes the given content to the vault as
// a new note. Shown when the user clicks "save to vault" on an assistant message.
export function VaultSaveModal(props: {
  content: string;
  onSave: (filename: string, tags: string[], content: string) => Promise<SaveResult>;
  onClose: () => void;
}) {
  const [filename, setFilename] = useState("");
  const [tagsStr, setTagsStr] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    const tags = tagsStr.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
    const r = await props.onSave(filename.trim() || "untitled", tags, props.content);
    setSaving(false);
    if (r.ok) { setSaved(r.path ?? "note"); setTimeout(props.onClose, 900); }
    else setError(r.error ?? "save failed");
  };

  const input = { fontFamily: MONO, fontSize: 12, background: "#0D0D12", color: "#C9C9D6", border: "1px solid #2A2A38", padding: "7px 9px", width: "100%", boxSizing: "border-box" as const };

  return (
    <div onClick={props.onClose} style={{ position: "fixed", inset: 0, background: "rgba(5,5,8,0.72)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(460px, 92vw)", background: "#101017", border: "2px solid #2A2A38", fontFamily: MONO, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", padding: "10px 12px", borderBottom: "2px solid #2A2A38" }}>
          <span style={{ fontSize: 11, letterSpacing: 2, color: "#A78BFA" }}>SAVE TO VAULT</span>
          <button type="button" onClick={props.onClose} style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 12, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
          {saved ? (
            <div style={{ fontSize: 12, color: "#4ADE80" }}>saved → {saved}</div>
          ) : (
            <>
              <label style={{ fontSize: 9, letterSpacing: 1, color: "#6B6B7B", display: "flex", flexDirection: "column", gap: 5 }}>
                FILENAME
                <input autoFocus value={filename} onChange={(e) => setFilename(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
                  placeholder="my note" style={input} />
              </label>
              <label style={{ fontSize: 9, letterSpacing: 1, color: "#6B6B7B", display: "flex", flexDirection: "column", gap: 5 }}>
                TAGS (comma or space separated)
                <input value={tagsStr} onChange={(e) => setTagsStr(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
                  placeholder="idea, dom" style={input} />
              </label>
              <div style={{ fontSize: 9, color: "#4A4A58" }}>{props.content.length} chars · .md added automatically</div>
              {error && <div style={{ fontSize: 11, color: "#F87171" }}>{error}</div>}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button type="button" onClick={props.onClose} style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1, background: "transparent", color: "#6B6B7B", border: "1px solid #2A2A38", padding: "6px 12px", cursor: "pointer" }}>CANCEL</button>
                <button type="button" onClick={() => void submit()} disabled={saving} style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1, background: "#A78BFA", color: "#0D0D12", border: 0, padding: "6px 14px", cursor: saving ? "default" : "pointer", opacity: saving ? 0.6 : 1 }}>{saving ? "SAVING…" : "SAVE"}</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

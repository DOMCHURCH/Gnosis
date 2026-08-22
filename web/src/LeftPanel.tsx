import { useEffect, useState } from "react";
import type { VaultTree } from "./filetypes";
import { FilesBody } from "./FileBrowser";
import { ObsidianBody } from "./ObsidianPanel";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

// The collapsible left panel: a tab switcher over FILES (the session cwd) and
// OBSIDIAN (the configured vault, .md only). The OBSIDIAN tab appears only when a
// vault is configured. Both bodies refresh off epochs owned by the parent — FILES
// on fileEpoch (tool.end), OBSIDIAN on the vault tree the parent re-fetches.
export function LeftPanel(props: {
  tabId: number | null;
  fileEpoch: number;
  vault: VaultTree | null;
  onAttach: (path: string) => void;
  onRefreshVault: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<"files" | "obsidian">("files");
  const [bump, setBump] = useState(0); // manual FILES refresh
  const hasVault = !!props.vault?.configured;

  // If the vault disappears while its tab is active, fall back to FILES.
  useEffect(() => { if (tab === "obsidian" && !hasVault) setTab("files"); }, [tab, hasVault]);
  const active = tab === "obsidian" && hasVault ? "obsidian" : "files";

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} title="show panel"
        style={{ flex: "0 0 26px", width: 26, alignSelf: "stretch", background: "#101017", color: "#6B6B7B", border: "2px solid #2A2A38", cursor: "pointer", fontFamily: MONO, fontSize: 10, letterSpacing: 1, writingMode: "vertical-rl" as const }}>
        {active === "obsidian" ? "OBSIDIAN ▸" : "FILES ▸"}
      </button>
    );
  }

  const tabBtn = (id: "files" | "obsidian", label: string, color: string) => (
    <button type="button" onClick={() => setTab(id)}
      style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 2, padding: "2px 2px", background: "transparent", border: 0, borderBottom: `2px solid ${active === id ? color : "transparent"}`, color: active === id ? color : "#4A4A58", cursor: "pointer" }}>
      {label}
    </button>
  );

  const refresh = () => { setBump((n) => n + 1); if (active === "obsidian") props.onRefreshVault(); };

  return (
    <div style={{ flex: "0 0 232px", width: 232, alignSelf: "stretch", minHeight: 0, background: "#15151C", border: "2px solid #2A2A38", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: "2px solid #2A2A38" }}>
        <div style={{ display: "flex", gap: 12 }}>
          {tabBtn("files", "FILES", "#22D3EE")}
          {hasVault && tabBtn("obsidian", "OBSIDIAN", "#A78BFA")}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={refresh} title="refresh" style={{ fontFamily: MONO, fontSize: 11, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer" }}>↻</button>
          <button type="button" onClick={() => setOpen(false)} title="hide" style={{ fontFamily: MONO, fontSize: 11, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer" }}>◂</button>
        </div>
      </div>
      <div style={{ flex: "1 1 auto", overflowY: "auto", overflowX: "hidden", padding: 6, minHeight: 0 }}>
        {active === "files" ? (
          <FilesBody tabId={props.tabId} fileEpoch={props.fileEpoch + bump} onAttach={props.onAttach} />
        ) : (
          <ObsidianBody vault={props.vault} />
        )}
      </div>
    </div>
  );
}

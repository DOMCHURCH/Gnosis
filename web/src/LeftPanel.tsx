import { useEffect, useState } from "react";
import type { VaultTree } from "./filetypes";
import type { ConnectionsData, MemoryData } from "./types";
import { FilesBody } from "./FileBrowser";
import { ObsidianBody } from "./ObsidianPanel";
import { ConnectionsBody } from "./ConnectionsPanel";
import { WebhooksBody } from "./WebhooksPanel";
import { Z } from "./layers";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

type Tab = "files" | "obsidian" | "connections" | "webhooks";

// The collapsible left panel: a tab switcher over FILES (the session cwd) and
// OBSIDIAN (the configured vault, .md only). The OBSIDIAN tab appears only when a
// vault is configured. Both bodies refresh off epochs owned by the parent — FILES
// on fileEpoch (tool.end), OBSIDIAN on the vault tree the parent re-fetches.
export function LeftPanel(props: {
  tabId: number | null;
  fileEpoch: number;
  vault: VaultTree | null;
  connections: ConnectionsData | null;
  memory: MemoryData | null;
  onAttach: (path: string) => void;
  onRefreshVault: () => void;
  onRefreshConnections: () => void;
  onToggleMcp: (name: string, enabled: boolean) => void;
  onClearMemory: () => void;
  webhookEpoch: number;
}) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<Tab>("files");
  const [bump, setBump] = useState(0); // manual FILES refresh
  const hasVault = !!props.vault?.configured;

  // If the vault disappears while its tab is active, fall back to FILES.
  useEffect(() => { if (tab === "obsidian" && !hasVault) setTab("files"); }, [tab, hasVault]);
  const active: Tab = tab === "obsidian" && !hasVault ? "files" : tab;

  if (!open) {
    return (
      <button type="button" data-testid="left-panel" onClick={() => setOpen(true)} title="show panel"
        style={{ flex: "0 0 26px", width: 26, alignSelf: "stretch", position: "relative", zIndex: Z.panel, background: "#121219", color: "#6B6B7B", border: "2px solid #2C2C3E", cursor: "pointer", fontFamily: MONO, fontSize: 10, letterSpacing: 1, writingMode: "vertical-rl" as const }}>
        {active.toUpperCase()} ▸
      </button>
    );
  }

  const tabBtn = (id: Tab, label: string, color: string) => (
    <button type="button" onClick={() => setTab(id)}
      style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 2, padding: "2px 2px", background: "transparent", border: 0, borderBottom: `2px solid ${active === id ? color : "transparent"}`, color: active === id ? color : "#4A4A58", cursor: "pointer" }}>
      {label}
    </button>
  );

  const refresh = () => { setBump((n) => n + 1); if (active === "obsidian") props.onRefreshVault(); if (active === "connections") props.onRefreshConnections(); if (active === "webhooks") setWebhookBump((n) => n + 1); };
  const [webhookBump, setWebhookBump] = useState(0);

  return (
    <div data-testid="left-panel" style={{ flex: "0 0 232px", width: 232, alignSelf: "stretch", position: "relative", zIndex: Z.panel, minHeight: 0, background: "#171721", border: "2px solid #2C2C3E", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Four tab labels are wider than 232px, so the row WRAPS. Without this the
          buttons overflow the panel and are drawn across the session selector. */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 6, padding: "8px 12px", borderBottom: "2px solid #2C2C3E" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, minWidth: 0, flex: "1 1 auto" }}>
          {tabBtn("files", "FILES", "#22D3EE")}
          {hasVault && tabBtn("obsidian", "OBSIDIAN", "#A78BFA")}
          {tabBtn("connections", "CONNECTIONS", "#EC4899")}
          {tabBtn("webhooks", "WEBHOOKS", "#4ADE80")}
        </div>
        <div style={{ display: "flex", gap: 8, flex: "0 0 auto" }}>
          <button type="button" onClick={refresh} title="refresh" style={{ fontFamily: MONO, fontSize: 11, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer" }}>↻</button>
          <button type="button" onClick={() => setOpen(false)} title="hide" style={{ fontFamily: MONO, fontSize: 11, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer" }}>◂</button>
        </div>
      </div>
      <div style={{ flex: "1 1 auto", overflowY: "auto", overflowX: "hidden", padding: 6, minHeight: 0 }}>
        {active === "files" ? (
          <FilesBody tabId={props.tabId} fileEpoch={props.fileEpoch + bump} onAttach={props.onAttach} />
        ) : active === "obsidian" ? (
          <ObsidianBody vault={props.vault} />
        ) : active === "connections" ? (
          <ConnectionsBody data={props.connections} memory={props.memory} onToggle={props.onToggleMcp} onClearMemory={props.onClearMemory} />
        ) : (
          <WebhooksBody webhookEpoch={props.webhookEpoch + webhookBump} localOrigin={typeof location !== "undefined" ? location.origin : ""} />
        )}
      </div>
    </div>
  );
}

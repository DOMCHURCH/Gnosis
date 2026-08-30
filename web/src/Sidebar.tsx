// The workspace sidebar.
//
// Replaces the old tab-strip left panel with the sectioned tree the redesign
// calls for: the project, its files, then sessions, memory and connections as
// collapsible sections. The BODIES are the existing ones — FilesBody,
// ObsidianBody, ConnectionsBody, WebhooksBody — so this is a reorganisation of
// the chrome around them, not a second implementation of any of them.
//
// Sections are independently collapsible and remember nothing: which one is open
// is a glance-level decision, not state worth persisting across launches.

import { useState } from "react";
import type { VaultTree } from "./filetypes";
import type { ConnectionsData, MemoryData } from "./types";
import { FilesBody } from "./FileBrowser";
import { ObsidianBody } from "./ObsidianPanel";
import { ConnectionsBody } from "./ConnectionsPanel";
import { WebhooksBody } from "./WebhooksPanel";
import { Z } from "./layers";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

/** Minimal line icons, drawn inline — six glyphs is not worth an icon font. */
function Icon({ name }: { name: string }) {
  const common = { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "cube":
      return <svg {...common}><path d="M21 16V8l-9-5-9 5v8l9 5 9-5z" /><path d="M3.3 7.6 12 12l8.7-4.4M12 12v9" /></svg>;
    case "folder":
      return <svg {...common}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
    case "clock":
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
    case "brain":
      return <svg {...common}><path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1 5.8A3 3 0 0 0 8 18a3 3 0 0 0 4 1 3 3 0 0 0 4-1 3 3 0 0 0 3-5.2A3 3 0 0 0 18 7a3 3 0 0 0-3-3 3 3 0 0 0-3 1 3 3 0 0 0-3-1z" /></svg>;
    case "link":
      return <svg {...common}><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" /></svg>;
    case "hook":
      return <svg {...common}><path d="M12 3v9a4 4 0 0 1-8 0" /><circle cx="12" cy="19" r="2" /></svg>;
    default:
      return null;
  }
}

/** A small count chip on a section header. Reading "3" beside SESSIONS without
 * opening it is the entire reason the workspace tier exists as its own tier. */
function Count({ n }: { n: number | null }) {
  if (n === null) return null;
  return (
    <span
      style={{
        flex: "0 0 auto", fontSize: 9, lineHeight: 1, letterSpacing: 0.4,
        color: n ? "#8A8A9B" : "#4A4A58", background: "rgba(255,255,255,0.05)",
        border: "1px solid rgba(255,255,255,0.06)", borderRadius: 999, padding: "3px 7px",
      }}
    >
      {n}
    </span>
  );
}

/**
 * A collapsible section, in one of two tiers.
 *
 * `nav` is the workspace tier — Sessions, Memory, Connections, Webhooks. These
 * are destinations: four fixed things you switch between, so they get weight, a
 * count chip, and a lit left rail when open.
 *
 * `tree` is the project tier — the project itself and the file list under it.
 * These are content, so they stay quiet and let the file rows inside them be the
 * thing you read.
 *
 * Both used to render identically, which is why the panel read as one
 * undifferentiated column of small uppercase monospace with no way in.
 */
function Section(props: {
  icon: string;
  label: string;
  open: boolean;
  onToggle: () => void;
  right?: React.ReactNode;
  children?: React.ReactNode;
  indent?: boolean;
  tier?: "nav" | "tree";
  count?: number | null;
}) {
  const nav = props.tier === "nav";
  const lit = nav && props.open;
  return (
    <div style={{ marginBottom: nav ? 3 : 2 }}>
      <div
        style={{
          display: "flex", alignItems: "center", gap: 9,
          padding: nav ? "10px 10px" : "8px 10px",
          paddingLeft: props.indent ? 22 : 10,
          cursor: "pointer", borderRadius: 10,
          // The lit rail is what tells you which destination you are in. On the
          // tree tier there is nothing to be "in", so there is no rail.
          boxShadow: lit ? "inset 2px 0 0 #22D3EE" : "none",
          background: lit ? "rgba(34,211,238,0.055)" : "transparent",
          color: nav ? (props.open ? "#E4E8EE" : "#9A9AAB") : props.open ? "#C9D1D9" : "#8A8A9B",
          transition: "background-color 200ms ease-out, color 200ms ease-out, box-shadow 200ms ease-out",
        }}
        onClick={props.onToggle}
        onMouseEnter={(e) => { if (!lit) e.currentTarget.style.background = "rgba(255,255,255,0.035)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = lit ? "rgba(34,211,238,0.055)" : "transparent"; }}
      >
        <span style={{ display: "flex", color: props.open ? "#22D3EE" : nav ? "#7A7A8B" : "#6B6B7B", flex: "0 0 auto" }}>
          <Icon name={props.icon} />
        </span>
        <span
          style={{
            flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            fontSize: nav ? 10.5 : 10,
            letterSpacing: nav ? 1.3 : 1.6,
            fontWeight: nav ? 500 : 400,
            textTransform: "uppercase",
          }}
        >
          {props.label}
        </span>
        {props.right}
        {nav ? <Count n={props.count ?? null} /> : null}
        <span style={{ fontSize: 10, color: "#4A4A58", flex: "0 0 auto", transition: "transform 200ms ease-out", transform: props.open ? "rotate(90deg)" : "none" }}>›</span>
      </div>
      {/* No maxHeight and no overflow here. A scroll box inside the panel's own
       * scroll box is what produced the double scrollbar, and capping every
       * section at 340px cramped the file tree into a slot while the panel below
       * it sat empty. Sections size to their content; the panel scrolls once. */}
      {props.open && props.children && (
        <div style={{ padding: nav ? "3px 0 10px" : "2px 0 8px" }}>{props.children}</div>
      )}
    </div>
  );
}

/** The rule between the project tier and the workspace tier. A labelled break is
 * cheaper to read than four differently-styled headers with nothing above them. */
function TierLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 8,
        margin: "14px 2px 7px", fontSize: 8.5, letterSpacing: 2.2, color: "#4A4A58",
        textTransform: "uppercase", whiteSpace: "nowrap",
      }}
    >
      {children}
      <span style={{ flex: 1, height: 1, background: "linear-gradient(90deg, rgba(255,255,255,0.08), transparent)" }} />
    </div>
  );
}

export function Sidebar(props: {
  project: string;
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
  onNewSession: () => void;
  sessions: { id: number; name: string; state: string; color: string }[];
  onSelectSession: (id: number) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({ project: true, files: true });
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const hasVault = !!props.vault?.configured;

  return (
    <div
      data-testid="left-panel"
      style={{
        flex: "0 0 264px", width: 264, alignSelf: "stretch", position: "relative", zIndex: Z.panel,
        minHeight: 0, display: "flex", flexDirection: "column", fontFamily: MONO,
        background: "#171721", border: "2px solid #2C2C3E",
      }}
    >
      {/* The panel's single scroll container. Nothing inside it may scroll on its
       * own — see the note on Section. */}
      <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "10px 8px 0" }}>
        <TierLabel>Project</TierLabel>
        <Section icon="cube" tier="tree" label={props.project} open={!!open.project} onToggle={() => toggle("project")}>
          <Section
            icon="folder"
            label="Files"
            indent
            tier="tree"
            open={!!open.files}
            onToggle={() => toggle("files")}
            right={
              <button
                type="button"
                title="refresh"
                onClick={(e) => { e.stopPropagation(); props.onRefreshVault(); }}
                style={{ fontFamily: MONO, fontSize: 12, lineHeight: 1, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer", padding: "0 4px" }}
              >
                +
              </button>
            }
          >
            {/* A hairline guide down the left of the tree. It is the cheapest way
             * to say "these rows belong to the folder above" without giving the
             * rows themselves any more weight. */}
            <div style={{ marginLeft: 27, paddingLeft: 9, borderLeft: "1px solid rgba(255,255,255,0.055)" }}>
              <FilesBody tabId={props.tabId} fileEpoch={props.fileEpoch} onAttach={props.onAttach} />
            </div>
          </Section>
        </Section>

        <TierLabel>Workspace</TierLabel>

        <Section icon="clock" tier="nav" count={props.sessions.length} label="Sessions" open={!!open.sessions} onToggle={() => toggle("sessions")}>
          {props.sessions.length === 0 ? (
            <div style={{ fontSize: 10, color: "#4A4A58", padding: "4px 10px" }}>no sessions</div>
          ) : (
            props.sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => props.onSelectSession(s.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                  fontFamily: MONO, fontSize: 11, color: "#C9C9D6", background: "transparent",
                  border: 0, borderLeft: `2px solid ${s.color}`, padding: "6px 10px", cursor: "pointer",
                }}
              >
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                <span style={{ fontSize: 9, color: "#6B6B7B" }}>{s.state}</span>
              </button>
            ))
          )}
        </Section>

        <Section
          icon="brain"
          tier="nav"
          count={hasVault ? (props.vault?.tree?.length ?? 0) : null}
          label="Memory"
          open={!!open.memory}
          onToggle={() => toggle("memory")}
        >
          {hasVault ? (
            <ObsidianBody vault={props.vault} />
          ) : (
            <div style={{ fontSize: 10, color: "#4A4A58", padding: "4px 10px", lineHeight: 1.7 }}>
              No vault configured. Add <span style={{ color: "#6B6B7B" }}>vault: &lt;path&gt;</span> to ~/.dom/AGENTS.md.
            </div>
          )}
        </Section>

        <Section
          icon="link"
          tier="nav"
          // Connected servers, not configured ones — the number worth glancing at
          // is how many are actually live.
          count={props.connections ? props.connections.mcp.filter((m) => m.status === "connected").length : null}
          label="Connections"
          open={!!open.connections}
          onToggle={() => toggle("connections")}
        >
          <ConnectionsBody
            data={props.connections}
            memory={props.memory}
            onToggle={props.onToggleMcp}
            onClearMemory={props.onClearMemory}
          />
        </Section>

        {/* No count: WebhooksBody fetches its own list, and the sidebar only
          * holds the epoch that invalidates it. A wrong number is worse than none. */}
        <Section icon="hook" tier="nav" label="Webhooks" open={!!open.webhooks} onToggle={() => toggle("webhooks")}>
          <WebhooksBody
            webhookEpoch={props.webhookEpoch}
            localOrigin={typeof location !== "undefined" ? location.origin : ""}
          />
        </Section>
      </div>

      {/* Pinned below the scroll area, with a rule, so it stays reachable however
       * long the tree gets — it is an action on the panel, not an item in it. */}
      <div style={{ padding: 10, flex: "0 0 auto", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        <button
          type="button"
          onClick={props.onNewSession}
          style={{
            width: "100%", fontFamily: MONO, fontSize: 10, letterSpacing: 1.6, textTransform: "uppercase",
            background: "#121219", color: "#C9D1D9", border: "1px solid rgba(255,255,255,0.08)",
            padding: "11px 12px", cursor: "pointer", display: "flex", alignItems: "center",
            justifyContent: "center", gap: 8, transition: "border-color 200ms ease-out, color 200ms ease-out",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(34,211,238,0.45)"; e.currentTarget.style.color = "#22D3EE"; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; e.currentTarget.style.color = "#C9D1D9"; }}
        >
          <span style={{ fontSize: 13, lineHeight: 1 }}>+</span> New session
        </button>
      </div>
    </div>
  );
}

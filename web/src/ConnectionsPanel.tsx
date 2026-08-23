import type { ConnectionsData, McpConnection } from "./types";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

const STATUS_COLOR: Record<McpConnection["status"], string> = {
  connected: "#4ADE80",
  connecting: "#FBBF24",
  error: "#F87171",
  disabled: "#6B6B7B",
};

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 9, letterSpacing: 2, color: "#6B6B7B", padding: "0 2px" }}>{props.title}</div>
      {props.children}
    </div>
  );
}

// A small terminal-style chip (replaces the shadcn Badge).
function Chip(props: { color: string; children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 8, letterSpacing: 1, color: props.color, background: "#15151C", border: "1px solid #2A2A38", padding: "1px 5px", whiteSpace: "nowrap" }}>{props.children}</span>
  );
}

// A flat terminal-style on/off toggle (replaces the shadcn Switch): a 26×14 track
// with a 10×10 knob, cyan when on and grey when off.
function Toggle(props: { on: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <button type="button" title={props.title} onClick={() => props.onChange(!props.on)}
      style={{ flex: "0 0 auto", width: 26, height: 14, padding: 0, position: "relative", cursor: "pointer", background: props.on ? "#22D3EE" : "#101017", border: `1px solid ${props.on ? "#22D3EE" : "#2A2A38"}` }}>
      <span style={{ position: "absolute", top: 1, left: props.on ? 13 : 1, width: 10, height: 10, background: props.on ? "#0D0D12" : "#6B6B7B", transition: "left 0.12s ease" }} />
    </button>
  );
}

/** The CONNECTIONS tab body: MCP servers (with a per-server enable/disable
 * toggle), API-key presence, loaded skills, and port-bound background jobs. */
export function ConnectionsBody(props: { data: ConnectionsData | null; onToggle: (name: string, enabled: boolean) => void }) {
  const d = props.data;
  if (!d) return <div style={{ fontFamily: MONO, fontSize: 11, color: "#6B6B7B", padding: 8 }}>loading…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, fontFamily: MONO }}>
      {/* --- MCP SERVERS --- */}
      <Section title="MCP SERVERS">
        {d.mcp.length === 0 && <div style={{ fontSize: 10, color: "#6B6B7B", padding: "2px 4px" }}>none configured (~/.dom/mcp.json)</div>}
        {d.mcp.map((s) => (
          <div key={s.name} style={{ background: "#101017", border: "2px solid #2A2A38", padding: 8, display: "flex", flexDirection: "column", gap: 5 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 7, height: 7, background: STATUS_COLOR[s.status] }} />
              <span style={{ fontSize: 11, letterSpacing: 1, color: "#C9C9D6", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
              <Toggle on={!s.disabled} onChange={(v) => props.onToggle(s.name, v)} title={s.disabled ? "enable" : "disable"} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <Chip color={STATUS_COLOR[s.status]}>{s.status.toUpperCase()}</Chip>
              <Chip color="#818CF8">{s.transport}</Chip>
              <Chip color="#6B6B7B">{s.toolCount} tool{s.toolCount === 1 ? "" : "s"}</Chip>
              {s.mutating && <Chip color="#FBBF24">MUTATING</Chip>}
            </div>
            {s.description && <div style={{ fontSize: 9, color: "#6B6B7B", lineHeight: 1.4 }}>{s.description}</div>}
            {s.error && <div style={{ fontSize: 9, color: "#F87171", lineHeight: 1.4, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{s.error}</div>}
            {s.tools.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 2 }}>
                {s.tools.map((t) => (
                  <span key={t.name} title={t.description} style={{ fontSize: 8, color: "#8A8A9B", background: "#15151C", border: "1px solid #2A2A38", padding: "1px 4px", whiteSpace: "nowrap" }}>{t.name}</span>
                ))}
              </div>
            )}
          </div>
        ))}
      </Section>

      {/* --- API KEYS --- */}
      <Section title="API KEYS">
        {d.keys.map((k) => (
          <div key={k.name} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 4px" }}>
            <span style={{ fontSize: 10, color: k.present ? "#C9C9D6" : "#F87171", opacity: k.present ? 1 : 0.7, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k.name}</span>
            {k.present
              ? <span style={{ fontSize: 9, color: "#6B6B7B", whiteSpace: "nowrap" }}>••••{k.last4}</span>
              : <span style={{ fontSize: 8, color: "#F87171", opacity: 0.8, whiteSpace: "nowrap", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }} title={k.feature ? `needed for: ${k.feature}` : "missing"}>{k.feature ? `needs: ${k.feature}` : "missing"}</span>}
          </div>
        ))}
      </Section>

      {/* --- SKILLS --- */}
      <Section title="SKILLS">
        {d.skills.length === 0 && <div style={{ fontSize: 10, color: "#6B6B7B", padding: "2px 4px" }}>none loaded</div>}
        {d.skills.map((s) => (
          <div key={s.name} style={{ padding: "2px 4px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 10, letterSpacing: 1, color: "#22D3EE", whiteSpace: "nowrap" }}>{s.name}</span>
              <span style={{ fontSize: 8, color: "#4A4A58" }}>{s.scope}</span>
            </div>
            <div style={{ fontSize: 9, color: "#6B6B7B", lineHeight: 1.4 }}>{s.description}</div>
          </div>
        ))}
      </Section>

      {/* --- HTTP (port-bound background jobs) --- */}
      <Section title="HTTP">
        {d.jobs.length === 0 && <div style={{ fontSize: 10, color: "#6B6B7B", padding: "2px 4px" }}>nothing serving on a port</div>}
        {d.jobs.map((j) => (
          <div key={j.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 4px" }}>
            <span style={{ width: 7, height: 7, background: j.status === "running" ? "#4ADE80" : "#6B6B7B" }} />
            <a href={`http://127.0.0.1:${j.port}`} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: "#22D3EE", textDecoration: "none", whiteSpace: "nowrap" }}>:{j.port}</a>
            <span style={{ fontSize: 9, color: "#6B6B7B", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.command}</span>
          </div>
        ))}
      </Section>
    </div>
  );
}

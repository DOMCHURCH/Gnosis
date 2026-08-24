import { useEffect, useState } from "react";
import type { WebhookData, WebhookEntry } from "./types";
import { apiGet, apiPost, token } from "./api";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

function timeOf(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}
function sizeOf(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`;
}
function pretty(body: string, contentType: string): string {
  if (/json/i.test(contentType) || /^[[{]/.test(body.trim())) {
    try { return JSON.stringify(JSON.parse(body), null, 2); } catch { /* not JSON */ }
  }
  return body;
}

/** One captured webhook: a compact line that expands to the JSON body (same
 * expand/collapse pattern as tool results in the chat rail), plus a replay button. */
function WebhookRow(props: { w: WebhookEntry; target: string }) {
  const { w } = props;
  const [open, setOpen] = useState(false);
  const [replayMsg, setReplayMsg] = useState<string>("");
  const replay = async () => {
    setReplayMsg("replaying…");
    const r = await apiPost<{ ok: boolean; status?: number; error?: string }>(`/api/webhooks/${w.id}/replay`, { target: props.target });
    setReplayMsg(r?.ok ? `→ ${r.status}` : `✗ ${r?.error ?? "failed"}`);
  };
  return (
    <div style={{ background: "#101017", border: "2px solid #2A2A38", display: "flex", flexDirection: "column" }}>
      <div onClick={() => setOpen((o) => !o)} title="click to expand" style={{ cursor: "pointer", padding: 8, display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 8, letterSpacing: 1, color: "#22D3EE", whiteSpace: "nowrap" }}>{w.method}</span>
          <span style={{ fontSize: 11, color: "#C9C9D6", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>/{w.label}</span>
          <span style={{ fontSize: 8, color: w.statusReturned < 300 ? "#4ADE80" : "#F87171" }}>{w.statusReturned}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 9, color: "#6B6B7B" }}>
          <span>{timeOf(w.receivedAt)}</span>
          <span>{sizeOf(w.size)}{w.truncated ? " (trunc)" : ""}</span>
          <span style={{ marginLeft: "auto", color: "#4A4A58" }}>{open ? "▾" : "▸"}</span>
        </div>
      </div>
      {open && (
        <div style={{ borderTop: "1px solid #2A2A38", display: "flex", flexDirection: "column" }}>
          <pre style={{ margin: 0, padding: 8, background: "#0B0B10", fontFamily: MONO, fontSize: 10, lineHeight: 1.5, color: "#C9C9D6", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 240, overflow: "auto" }}>{pretty(w.body, w.contentType) || "(empty body)"}</pre>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderTop: "1px solid #2A2A38" }}>
            <button type="button" onClick={replay} style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 1, background: "#15151C", color: "#22D3EE", border: "2px solid #2A2A38", padding: "4px 9px", cursor: "pointer" }}>REPLAY</button>
            {replayMsg && <span style={{ fontSize: 9, color: "#6B6B7B" }}>{replayMsg}</span>}
            <span style={{ marginLeft: "auto", fontSize: 8, color: "#4A4A58" }}>→ {props.target}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** The WEBHOOKS tab body: a URL generator at the top, a filter, then the captured
 * webhooks. Flat and terminal-styled — same structure as FILES / CONNECTIONS. */
export function WebhooksBody(props: { webhookEpoch: number; localOrigin: string }) {
  const [data, setData] = useState<WebhookData | null>(null);
  const [label, setLabel] = useState("test");
  const [filter, setFilter] = useState("");
  const [target, setTarget] = useState("http://127.0.0.1:3000/webhook");
  const [copied, setCopied] = useState(false);
  useEffect(() => { void apiGet<WebhookData>("/api/webhooks").then(setData); }, [props.webhookEpoch]);

  // External services need the PUBLIC url when a tunnel is up; else the local one.
  const base = data?.public ?? props.localOrigin;
  const hookUrl = `${base.replace(/\/$/, "")}/webhook/${encodeURIComponent(label || "test")}?token=${token()}`;
  const copy = () => { void navigator.clipboard?.writeText(hookUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); };

  const list = (data?.webhooks ?? []).filter((w) => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    return w.label.toLowerCase().includes(q) || w.body.toLowerCase().includes(q);
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, fontFamily: MONO }}>
      {/* URL generator */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 9, letterSpacing: 2, color: "#6B6B7B" }}>WEBHOOK URL{data?.public ? " · PUBLIC" : ""}</div>
        <div style={{ display: "flex", gap: 6 }}>
          <span style={{ fontSize: 10, color: "#6B6B7B", alignSelf: "center" }}>label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value.replace(/\s+/g, "-"))} style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 10, color: "#C9C9D6", background: "#101017", border: "2px solid #2A2A38", padding: "5px 6px", outline: "none" }} />
        </div>
        <div onClick={copy} title="click to copy" style={{ cursor: "pointer", fontSize: 9, color: "#22D3EE", background: "#0B0B10", border: "2px solid #2A2A38", padding: "6px 7px", wordBreak: "break-all", lineHeight: 1.4 }}>{hookUrl}</div>
        <div style={{ fontSize: 8, color: copied ? "#4ADE80" : "#4A4A58", letterSpacing: 1 }}>{copied ? "COPIED — paste into Stripe / GitHub / …" : "click the URL to copy"}</div>
      </div>

      {/* filter + replay target */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter by label or payload…" style={{ fontFamily: MONO, fontSize: 10, color: "#C9C9D6", background: "#101017", border: "2px solid #2A2A38", padding: "5px 6px", outline: "none" }} />
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 9, color: "#6B6B7B" }}>replay →</span>
          <input value={target} onChange={(e) => setTarget(e.target.value)} style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 9, color: "#C9C9D6", background: "#101017", border: "2px solid #2A2A38", padding: "5px 6px", outline: "none" }} />
        </div>
      </div>

      {/* captured webhooks */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 9, letterSpacing: 2, color: "#6B6B7B" }}>RECEIVED · {list.length}</div>
        {list.length === 0 && <div style={{ fontSize: 10, color: "#6B6B7B", padding: "2px 4px" }}>nothing captured yet — POST to the URL above</div>}
        {list.map((w) => <WebhookRow key={w.id} w={w} target={target} />)}
      </div>
    </div>
  );
}

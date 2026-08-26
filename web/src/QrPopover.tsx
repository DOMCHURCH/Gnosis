import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Z } from "./layers";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

export interface QrCode { title: string; url: string; color: string }

/** One labelled QR tile: the code as an inline SVG (via the bundled `qrcode` lib —
 * no external image requests) with near-black modules on a light tile so it scans. */
function QrTile(props: { code: QrCode; compact: boolean }) {
  const [svg, setSvg] = useState<string>("");
  const { url } = props.code;
  useEffect(() => {
    let live = true;
    void QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#0D0D12", light: "#C9C9D6" } }).then((s) => { if (live) setSvg(s); });
    return () => { live = false; };
  }, [url]);
  const side = props.compact ? 168 : 240;
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 9, letterSpacing: 2, color: props.code.color, padding: "6px 11px", borderBottom: "2px solid #2A2A38" }}>{props.code.title}</div>
      <div style={{ padding: 12, display: "flex", justifyContent: "center", background: "#C9C9D6" }}>
        <div style={{ width: side, height: side }} dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
      <div style={{ padding: "8px 11px", display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 9, letterSpacing: 1, color: "#6B6B7B", wordBreak: "break-all", lineHeight: 1.4 }}>{url}</div>
        <a href={url} target="_blank" rel="noreferrer" style={{ fontSize: 9, letterSpacing: 2, color: "#22D3EE", textDecoration: "none" }}>OPEN ↗</a>
      </div>
    </div>
  );
}

/**
 * The serve QR popover. Shows EVERY reachable URL side by side — LOCAL and LAN
 * always, PUBLIC when a tunnel is up — so a phone on the same WiFi can scan the LAN
 * code without the desktop user hunting for a second menu entry. Framed in the
 * existing dark palette (#0D0D12 bg, #2A2A38 border, no rounded corners, monospace).
 */
export function QrPopover(props: { title: string; codes: QrCode[]; onClose: () => void }) {
  const many = props.codes.length > 1;
  return (
    <div onClick={props.onClose} style={{ position: "fixed", inset: 0, zIndex: Z.overlay, background: "rgba(5,5,8,0.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 12 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#0D0D12", border: "2px solid #2A2A38", fontFamily: MONO, width: many ? "min(660px, 96vw)" : "min(320px, 92vw)", maxHeight: "94vh", overflowY: "auto", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 11px", borderBottom: "2px solid #2A2A38" }}>
          <span style={{ fontSize: 10, letterSpacing: 2, color: "#22D3EE" }}>{props.title}</span>
          <span style={{ fontSize: 9, letterSpacing: 1, color: "#6B6B7B" }}>TOKEN REQUIRED</span>
          <button type="button" onClick={props.onClose} style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 12, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "stretch" }}>
          {props.codes.map((c, i) => (
            <div key={c.title} style={{ display: "flex", flex: "1 1 240px", minWidth: 0, borderLeft: i > 0 ? "2px solid #2A2A38" : 0 }}>
              <QrTile code={c} compact={many} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

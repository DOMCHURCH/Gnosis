import { useEffect, useState } from "react";
import QRCode from "qrcode";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

/**
 * A small QR popover for a serve/webhook URL. The QR is rendered as an inline SVG
 * (via the bundled `qrcode` lib — no external image requests) with near-black
 * modules on a light tile so it scans, framed in the existing dark palette
 * (#0D0D12 bg, #2A2A38 border, no rounded corners, monospace labels).
 */
export function QrPopover(props: { title: string; url: string; onClose: () => void }) {
  const [svg, setSvg] = useState<string>("");
  useEffect(() => {
    let live = true;
    void QRCode.toString(props.url, { type: "svg", margin: 1, color: { dark: "#0D0D12", light: "#C9C9D6" } }).then((s) => { if (live) setSvg(s); });
    return () => { live = false; };
  }, [props.url]);

  return (
    <div onClick={props.onClose} style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(5,5,8,0.72)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#0D0D12", border: "2px solid #2A2A38", fontFamily: MONO, width: "min(320px, 92vw)", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 11px", borderBottom: "2px solid #2A2A38" }}>
          <span style={{ fontSize: 10, letterSpacing: 2, color: "#22D3EE" }}>{props.title}</span>
          <button type="button" onClick={props.onClose} style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 12, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ padding: 14, display: "flex", justifyContent: "center", background: "#C9C9D6" }}>
          <div style={{ width: 240, height: 240 }} dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
        <div style={{ padding: "8px 11px", borderTop: "2px solid #2A2A38", display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 9, letterSpacing: 1, color: "#6B6B7B", wordBreak: "break-all", lineHeight: 1.4 }}>{props.url}</div>
          <a href={props.url} target="_blank" rel="noreferrer" style={{ fontSize: 9, letterSpacing: 2, color: "#22D3EE", textDecoration: "none" }}>OPEN ↗</a>
        </div>
      </div>
    </div>
  );
}

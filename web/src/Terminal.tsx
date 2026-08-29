import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Z } from "./layers";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

function token(): string {
  return new URLSearchParams(location.search).get("token") ?? "";
}

// One xterm.js instance bound to a dedicated /pty websocket in the active tab's cwd.
// Terminal bytes flow both ways over this socket only — never through the app event
// stream, so nothing typed or printed here is seen by the model. Ctrl+C is ordinary
// input (0x03). The fit addon measures the box and we tell the server the new size.
function TerminalInstance(props: { tabId: number | null; active: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");

  useEffect(() => {
    const host = hostRef.current;
    if (!host || props.tabId == null) return;
    const term = new XTerm({ fontFamily: MONO, fontSize: 12, theme: { background: "#0B0B10", foreground: "#C9C9D6" }, cursorBlink: true, scrollback: 4000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try { fit.fit(); } catch { /* not laid out yet */ }

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const q = `token=${encodeURIComponent(token())}&tabId=${props.tabId}&cols=${term.cols}&rows=${term.rows}`;
    const ws = new WebSocket(`${proto}://${location.host}/pty?${q}`);
    ws.binaryType = "arraybuffer";

    const sendResize = () => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ r: { cols: term.cols, rows: term.rows } })); };
    ws.onopen = () => { setStatus("open"); sendResize(); term.focus(); };
    ws.onmessage = (e) => { term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data)); };
    ws.onclose = () => setStatus("closed");
    ws.onerror = () => { try { ws.close(); } catch { /* closing */ } };

    const dataSub = term.onData((d) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ d })); });
    const refit = () => { try { fit.fit(); sendResize(); } catch { /* ignore */ } };
    const ro = new ResizeObserver(refit);
    ro.observe(host);
    window.addEventListener("resize", refit);

    return () => {
      window.removeEventListener("resize", refit);
      ro.disconnect();
      dataSub.dispose();
      try { ws.close(); } catch { /* already closing */ }
      term.dispose();
    };
  }, [props.tabId]);

  return (
    <div style={{ position: "relative", flex: "1 1 auto", minHeight: 0 }}>
      <div ref={hostRef} style={{ position: "absolute", inset: 0, padding: 6 }} />
      {status !== "open" && (
        <div style={{ position: "absolute", right: 10, top: 6, fontFamily: MONO, fontSize: 9, letterSpacing: 1, color: status === "closed" ? "#F87171" : "#6B6B7B" }}>
          {status === "closed" ? "DISCONNECTED" : "CONNECTING…"}
        </div>
      )}
    </div>
  );
}

// Resizable bottom terminal dock with multiple tabs, each its own pty in the active
// session's cwd. Opened from the page's chrome band (App owns `open`) rather than a
// floating corner button, so nothing of it sits on top of the page while closed.
export function TerminalDock(props: { tabId: number | null; open: boolean; onClose: () => void }) {
  const open = props.open;
  const [height, setHeight] = useState(300);
  const [tabs, setTabs] = useState<number[]>([0]);
  const [activeTab, setActiveTab] = useState(0);
  const [seq, setSeq] = useState(1);
  const dragRef = useRef<{ y: number; h: number } | null>(null);

  useEffect(() => {
    const move = (e: MouseEvent) => { const d = dragRef.current; if (d) setHeight(Math.max(120, Math.min(700, d.h + (d.y - e.clientY)))); };
    const up = () => { dragRef.current = null; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, []);

  // While the dock is open the page reserves its height, so a docked terminal
  // pushes the layout up instead of covering the bottom of it. Cleared on close.
  useEffect(() => {
    const root = document.documentElement;
    if (open) root.style.setProperty("--dom-dock-h", `${height}px`);
    else root.style.removeProperty("--dom-dock-h");
    return () => { root.style.removeProperty("--dom-dock-h"); };
  }, [open, height]);

  const addTab = () => { const id = seq; setSeq(seq + 1); setTabs((t) => [...t, id]); setActiveTab(id); };
  const closeTab = (id: number) => {
    setTabs((t) => { const next = t.filter((x) => x !== id); if (activeTab === id && next.length) setActiveTab(next[next.length - 1]!); return next; });
  };

  if (!open) return null;

  return (
    <div data-testid="terminal-dock" style={{ position: "fixed", left: 0, right: 0, bottom: 0, height, zIndex: Z.dock, background: "#0B0B10", borderTop: "2px solid #2C2C3E", display: "flex", flexDirection: "column", fontFamily: MONO }}>
      <div data-testid="dock-handle" onMouseDown={(e) => { dragRef.current = { y: e.clientY, h: height }; }} style={{ height: 6, cursor: "ns-resize", background: "#171721", borderBottom: "1px solid #2C2C3E" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderBottom: "2px solid #2C2C3E" }}>
        <span style={{ fontSize: 9, letterSpacing: 2, color: "#6B6B7B", marginRight: 6 }}>TERMINAL</span>
        {tabs.map((id, i) => (
          <div key={id} style={{ display: "flex", alignItems: "center", background: id === activeTab ? "#23232F" : "transparent", border: `1px solid ${id === activeTab ? "#22D3EE" : "#2C2C3E"}` }}>
            <button type="button" onClick={() => setActiveTab(id)} style={{ fontFamily: MONO, fontSize: 10, background: "transparent", color: id === activeTab ? "#C9C9D6" : "#6B6B7B", border: 0, padding: "3px 8px", cursor: "pointer" }}>sh {i + 1}</button>
            {tabs.length > 1 && <button type="button" onClick={() => closeTab(id)} title="close" style={{ fontFamily: MONO, fontSize: 10, background: "transparent", color: "#6B6B7B", border: 0, padding: "0 6px 0 0", cursor: "pointer" }}>✕</button>}
          </div>
        ))}
        <button type="button" onClick={addTab} title="new terminal" style={{ fontFamily: MONO, fontSize: 12, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer", padding: "0 6px" }}>+</button>
        <button type="button" onClick={props.onClose} title="hide" style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 11, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer" }}>▾ hide</button>
      </div>
      <div style={{ flex: "1 1 auto", minHeight: 0, position: "relative" }}>
        {tabs.map((id) => (
          // Keep every tab mounted (its pty/scrollback survives switching); hide inactive.
          <div key={id} style={{ position: "absolute", inset: 0, display: id === activeTab ? "flex" : "none", flexDirection: "column" }}>
            <TerminalInstance tabId={props.tabId} active={id === activeTab} />
          </div>
        ))}
      </div>
    </div>
  );
}

import hljs from "highlight.js/lib/common";
import { langFromPath } from "./difftwopane.js";
import type { StreamEdit } from "./store";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

function hl(text: string, lang?: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(text, { language: lang }).value;
    return hljs.highlightAuto(text).value;
  } catch {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

function Num(props: { n: number | null }) {
  return <span style={{ flex: "0 0 34px", textAlign: "right", padding: "0 6px", color: "#4A4A58", userSelect: "none", fontSize: 10 }}>{props.n ?? ""}</span>;
}

/**
 * Live diff viewer for a streaming edit. Left pane: the original file, static and
 * dim. Right pane: the new content, filling in line by line as edit.line events
 * arrive — changed lines highlighted green, matching lines dim, a blinking cursor
 * at the current write position. A progress bar tracks received/total lines. On
 * edit.commit the cursor disappears, the diff locks in, and an Undo button appears.
 */
export function StreamDiff(props: { edit: StreamEdit; onUndo: () => void }) {
  const e = props.edit;
  const lang = langFromPath(e.path);
  const rows = Math.max(e.original.length, e.done ? e.lines.length : e.totalLines);
  const pct = e.totalLines > 0 ? Math.min(100, Math.round((e.lines.length / e.totalLines) * 100)) : 0;
  const cursorAt = e.lines.length; // right-pane row index the cursor sits on

  const left = [];
  const right = [];
  for (let i = 0; i < rows; i++) {
    const o = e.original[i];
    left.push(
      <div key={i} style={{ display: "flex", minHeight: 17, opacity: 0.5 }}>
        <Num n={o !== undefined ? i + 1 : null} />
        <span style={{ flex: 1, minWidth: 0, whiteSpace: "pre", overflow: "hidden" }} dangerouslySetInnerHTML={{ __html: o !== undefined ? hl(o, lang) : "" }} />
      </div>,
    );
    const nl = e.lines[i];
    const isCursor = !e.done && i === cursorAt;
    right.push(
      <div key={i} style={{ display: "flex", minHeight: 17, background: nl?.changed ? "rgba(74,222,128,0.16)" : "transparent", opacity: nl ? (nl.changed ? 1 : 0.55) : 1 }}>
        <Num n={nl ? i + 1 : null} />
        <span style={{ flex: 1, minWidth: 0, whiteSpace: "pre", overflow: "hidden" }} dangerouslySetInnerHTML={{ __html: nl ? hl(nl.text, lang) : "" }} />
        {isCursor && <span className="dom-editcursor" style={{ display: "inline-block", width: 7, height: 13, background: "#22D3EE", marginLeft: 2 }} />}
      </div>,
    );
  }

  return (
    <div style={{ margin: "6px 12px", border: "1px solid #2A2A38", background: "#0B0B10", fontFamily: MONO }}>
      <style>{"@keyframes domblink{0%,49%{opacity:1}50%,100%{opacity:0}} .dom-editcursor{animation:domblink .9s step-end infinite}"}</style>
      {/* header: path, live status, progress bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderBottom: "1px solid #2A2A38", fontSize: 11, color: "#C9C9D6" }}>
        <span style={{ color: e.done ? (e.ok ? "#4ADE80" : "#F87171") : "#22D3EE" }}>●</span>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {e.done ? (e.ok ? "edited " : "aborted ") : "writing "}{e.path}
        </span>
        <span style={{ color: "#6B6B7B", fontSize: 10 }}>{e.lines.length}/{e.totalLines} lines · {e.chars} chars</span>
        {e.done && e.ok && (
          <button onClick={props.onUndo} style={{ background: "#17171F", color: "#F0A0A0", border: "1px solid #3A2A2A", padding: "2px 8px", fontFamily: MONO, fontSize: 10, cursor: "pointer" }}>
            undo
          </button>
        )}
      </div>
      {/* progress bar (streaming only) */}
      {!e.done && (
        <div style={{ height: 2, background: "#1A1A22" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: "#22D3EE", transition: "width 0.1s linear" }} />
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", fontSize: 11, lineHeight: 1.55, maxHeight: 360, overflow: "auto" }}>
        <div style={{ borderRight: "1px solid #2A2A38" }}>{left}</div>
        <div>{right}</div>
      </div>
    </div>
  );
}

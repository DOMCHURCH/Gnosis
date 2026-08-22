import hljs from "highlight.js/lib/common";
import { parseUnifiedDiff, langFromPath } from "./difftwopane.js";
import type { DiffCell } from "./difftwopane";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

/** Highlight one line to HTML (best-effort); falls back to escaped plain text. */
function hl(text: string, lang?: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(text, { language: lang }).value;
    return hljs.highlightAuto(text).value;
  } catch {
    return escapeHtml(text);
  }
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function Cell(props: { cell: DiffCell | null; lang?: string; bg: string; sign: string }) {
  const { cell } = props;
  return (
    <div style={{ display: "flex", background: cell ? props.bg : "transparent", minHeight: 17 }}>
      <span style={{ flex: "0 0 34px", textAlign: "right", padding: "0 6px", color: "#4A4A58", userSelect: "none", fontSize: 10 }}>{cell?.num ?? ""}</span>
      <span style={{ flex: "0 0 10px", color: "#6B6B7B", userSelect: "none" }}>{cell ? props.sign : ""}</span>
      <span style={{ flex: 1, minWidth: 0, whiteSpace: "pre", overflow: "hidden" }}
        dangerouslySetInnerHTML={{ __html: cell ? hl(cell.text, props.lang) : "" }} />
    </div>
  );
}

// Two-pane before/after diff for an edit: deletions (red) left, additions (green)
// right, context on both, real line numbers, per-line syntax highlight (highlight.js).
export function DiffView(props: { detail: string; path: string }) {
  const lang = langFromPath(props.path);
  const rows = parseUnifiedDiff(props.detail);
  return (
    <div style={{ marginLeft: 12, border: "1px solid #2A2A38", background: "#0B0B10", maxHeight: 360, overflow: "auto", fontFamily: MONO, fontSize: 11, lineHeight: 1.55 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
        <div style={{ borderRight: "1px solid #2A2A38" }}>
          {rows.map((r, i) => <Cell key={i} cell={r.left} lang={lang} sign={r.type === "context" ? " " : "-"} bg={r.type === "context" ? "transparent" : "rgba(248,113,113,0.14)"} />)}
        </div>
        <div>
          {rows.map((r, i) => <Cell key={i} cell={r.right} lang={lang} sign={r.type === "context" ? " " : "+"} bg={r.type === "context" ? "transparent" : "rgba(74,222,128,0.14)"} />)}
        </div>
      </div>
    </div>
  );
}

// A write shows the full new file content (not a diff), syntax-highlighted.
export function FileView(props: { detail: string; path: string }) {
  const lang = langFromPath(props.path);
  return (
    <pre style={{ margin: 0, marginLeft: 12, padding: "6px 8px", background: "#0B0B10", border: "1px solid #2A2A38", borderLeft: "3px solid #22D3EE", fontFamily: MONO, fontSize: 11, lineHeight: 1.5, color: "#C9C9D6", whiteSpace: "pre", maxHeight: 360, overflow: "auto" }}
      dangerouslySetInnerHTML={{ __html: hl(props.detail, lang) }} />
  );
}

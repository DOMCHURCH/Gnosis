import { useEffect, useState } from "react";
import hljs from "highlight.js/lib/common";
import type { FileOutput as FileOut } from "./filekind";
import { parseCsv } from "./filekind.js";
import { Z } from "./layers";
import { Overlay } from "./Overlay";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
/** Code preview cap. Past this the block collapses behind "show full file". */
const CODE_LINES = 50;
/** An object with more keys than this starts collapsed. */
const JSON_KEYS = 10;

function hl(text: string, lang: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(text, { language: lang }).value;
    return hljs.highlightAuto(text).value;
  } catch {
    // Show the file, unhighlighted, rather than nothing. Returning "" here meant
    // a highlighter that threw — on an unusual language, or a pathological line
    // — silently emptied the pane, so the user saw a file they had opened as
    // blank with no error to explain it. Escaped because this is injected as
    // HTML; hljs escapes its own output, and the fallback has to as well.
    return escapeHtml(text);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function bytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

const card = {
  display: "flex", alignItems: "center", gap: 10, background: "#0B0B10",
  border: "1px solid #2C2C3E", padding: "8px 10px", cursor: "pointer",
} as const;

const btn = {
  fontFamily: "inherit", fontSize: 9, letterSpacing: 1, background: "transparent",
  color: "#818CF8", border: "1px solid #2C2C3E", padding: "3px 8px", cursor: "pointer",
} as const;

/**
 * Rich rendering for a file the agent just wrote. Bytes and text come back over
 * the same token-gated, root-guarded endpoints the file browser uses, so nothing
 * here can reach outside the session's own directory.
 */
export function FileOutputView(props: {
  out: FileOut;
  /** Builds a token-gated URL: raw bytes when `raw`, the JSON text preview otherwise. */
  fileUrl: (path: string, raw: boolean) => string;
  onSaveVault?: (path: string) => void;
}) {
  const { out } = props;
  const [text, setText] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  // A path guessed from a shell command is unverified: confirm it actually exists
  // before drawing anything, or a stray token in a command line becomes a broken
  // image in the rail.
  const [exists, setExists] = useState<boolean | null>(out.verify ? null : true);

  useEffect(() => {
    if (!out.verify) { setExists(true); return; }
    let live = true;
    setExists(null);
    fetch(props.fileUrl(out.path, true), { method: "HEAD" })
      .then((r) => { if (live) setExists(r.ok); })
      .catch(() => { if (live) setExists(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [out.path, out.verify]);

  const needsText = out.kind === "code" || out.kind === "json" || out.kind === "csv";

  useEffect(() => {
    if (!needsText || exists !== true) return;
    let live = true;
    fetch(props.fileUrl(out.path, false))
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { content?: string } | null) => { if (live && j && j.content != null) setText(j.content); })
      .catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [out.path, needsText, exists]);

  // Size for the PDF / generic cards: a HEAD avoids pulling the whole file just to
  // print "2.1 MB".
  useEffect(() => {
    if (out.kind !== "pdf" && out.kind !== "generic") return;
    let live = true;
    fetch(props.fileUrl(out.path, true), { method: "HEAD" })
      .then((r) => { const n = Number(r.headers.get("content-length")); if (live && n) setSize(n); })
      .catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [out.path, out.kind]);

  // Unverified or confirmed-missing: render nothing at all rather than a broken box.
  if (exists !== true) return null;

  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 9, letterSpacing: 1, color: "#6B6B7B" }}>
      <span style={{ color: "#818CF8" }}>{out.name}</span>
      {text != null && <CopyButton text={text} />}
    </div>
  );

  if (out.kind === "image") {
    const src = props.fileUrl(out.path, true);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {header}
        <img
          src={src}
          alt={out.name}
          onClick={() => setLightbox(true)}
          style={{ maxWidth: 300, maxHeight: 300, border: "1px solid #2C2C3E", cursor: "zoom-in", display: "block" }}
        />
        {props.onSaveVault && (
          <div style={{ display: "flex" }}>
            <button type="button" style={btn} onClick={() => props.onSaveVault && props.onSaveVault(out.path)}>
              &#8595; SAVE TO VAULT
            </button>
          </div>
        )}
        {lightbox && (
          <Overlay onClose={() => setLightbox(false)}>
            <img src={src} alt={out.name} style={{ maxWidth: "92vw", maxHeight: "88vh", border: "1px solid #2C2C3E", cursor: "zoom-out" }} />
          </Overlay>
        )}
      </div>
    );
  }

  if (out.kind === "pdf" || out.kind === "generic") {
    // A PDF is never rendered inline: it opens in its own tab, where the browser's
    // own viewer does a better job than anything embedded here.
    return (
      <a href={props.fileUrl(out.path, true)} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
        <div style={card}>
          <span style={{ fontSize: 18 }}>{out.kind === "pdf" ? "\u{1F4D5}" : "\u{1F4C4}"}</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 11, color: "#C9C9D6" }}>{out.name}</span>
            <span style={{ fontSize: 9, letterSpacing: 1, color: "#6B6B7B" }}>
              {out.ext.replace(".", "").toUpperCase()}
              {size != null ? " · " + bytes(size) : ""} · opens in a new tab
            </span>
          </div>
        </div>
      </a>
    );
  }

  if (out.kind === "csv") {
    const rows = parseCsv(text || "", 6);
    if (!rows.length) return header;
    const head = rows[0];
    const body = rows.slice(1);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {header}
        <div style={{ overflowX: "auto", border: "1px solid #2C2C3E" }}>
          <table style={{ borderCollapse: "collapse", fontFamily: MONO, fontSize: 10, minWidth: "100%" }}>
            <thead>
              <tr>
                {head.map((c, i) => (
                  <th key={i} style={{ textAlign: "left", padding: "5px 8px", background: "#171721", color: "#818CF8", borderBottom: "1px solid #2C2C3E", whiteSpace: "nowrap" }}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, i) => (
                <tr key={i}>
                  {head.map((_, j) => (
                    <td key={j} style={{ padding: "4px 8px", color: "#C9C9D6", borderBottom: "1px solid #1A1A22", whiteSpace: "nowrap" }}>{r[j] || ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <span style={{ fontSize: 9, letterSpacing: 1, color: "#4A4A58" }}>first {body.length} rows</span>
      </div>
    );
  }

  // code + json
  if (text == null) return header;
  let collapsedByDefault = false;
  if (out.kind === "json") {
    try {
      const parsed = JSON.parse(text);
      collapsedByDefault = !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length > JSON_KEYS;
    } catch {
      /* not valid JSON — render it as written */
    }
  }
  const lines = text.split("\n");
  const capped = lines.length > CODE_LINES;
  const shown = expanded
    ? text
    : collapsedByDefault
      ? lines.slice(0, 12).join("\n")
      : capped
        ? lines.slice(0, CODE_LINES).join("\n")
        : text;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      {header}
      <div style={{ background: "#0B0B10", border: "1px solid #2C2C3E", borderLeft: "3px solid #818CF8", padding: "6px 8px", overflowX: "auto" }}>
        <pre style={{ margin: 0, fontFamily: MONO, fontSize: 11, lineHeight: 1.5, color: "#C9C9D6", whiteSpace: "pre" }}>
          <code dangerouslySetInnerHTML={{ __html: hl(shown, out.lang) }} />
        </pre>
      </div>
      {(capped || collapsedByDefault) && (
        <div style={{ display: "flex" }}>
          <button type="button" style={btn} onClick={() => setExpanded((v) => !v)}>
            {expanded ? "COLLAPSE" : "SHOW FULL FILE (" + lines.length + " lines)"}
          </button>
        </div>
      )}
    </div>
  );
}

function CopyButton(props: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      style={{ ...btn, color: done ? "#4ADE80" : "#818CF8" }}
      onClick={() => {
        const c = navigator.clipboard;
        if (!c) return;
        void c.writeText(props.text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }).catch(() => {});
      }}
    >
      {done ? "COPIED" : "COPY"}
    </button>
  );
}

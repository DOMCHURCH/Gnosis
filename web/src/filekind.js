// Classifies a file the agent just wrote so the chat rail can render it as more
// than a grey "wrote path" line. Pure and dependency-free so both the browser and
// the Node verify run import the same rules.

/** Extension → how the rail should present it. */
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);
const CODE = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go",
  ".css", ".scss", ".html", ".yaml", ".yml", ".sh", ".sql", ".java", ".rb", ".c", ".h", ".cpp",
]);

/** highlight.js language ids, where they differ from the bare extension. */
const LANG = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
  ".mjs": "javascript", ".cjs": "javascript", ".py": "python", ".rs": "rust", ".go": "go",
  ".css": "css", ".scss": "scss", ".html": "xml", ".yaml": "yaml", ".yml": "yaml",
  ".json": "json", ".sh": "bash", ".sql": "sql", ".java": "java", ".rb": "ruby",
  ".c": "c", ".h": "c", ".cpp": "cpp",
};

export function extOf(p) {
  const m = /\.[^./\\]+$/.exec(String(p || ""));
  return m ? m[0].toLowerCase() : "";
}

/**
 * The render kind for a written path, or null when nothing richer than the normal
 * tool line applies.
 *   image   — inline thumbnail, click to expand
 *   code    — highlighted block, capped, expandable
 *   json    — highlighted, collapsed when large
 *   csv     — first rows as a table
 *   pdf     — card, opens in a new tab, never inline
 *   generic — download card
 */
export function fileKind(p) {
  const ext = extOf(p);
  if (!ext) return null;
  if (IMAGE.has(ext)) return "image";
  if (ext === ".json") return "json";
  if (ext === ".csv") return "csv";
  if (ext === ".pdf") return "pdf";
  if (CODE.has(ext)) return "code";
  return "generic";
}

export function langOf(p) {
  return LANG[extOf(p)] || "";
}

/**
 * Paths a bash command plausibly produced. A chart is written by a SCRIPT, never
 * by the write tool, so a write-only trigger would miss the most common case
 * entirely — we scan the command and its output for anything that looks like a
 * renderable file. Candidates are unverified by construction, so the renderer
 * confirms each one exists before drawing it.
 */
export function candidatePaths(text) {
  const out = [];
  const seen = new Set();
  // A path-ish token ending in an extension we know how to render.
  const re = /[A-Za-z0-9_./\\-]+\.[A-Za-z0-9]{1,5}/g;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    let p = m[0].replace(/^[.]{1,2}[/\\]/, "");
    if (p.length > 200 || seen.has(p)) continue;
    seen.add(p);
    const kind = fileKind(p);
    // Only media worth showing. Code/generic from a shell line is almost always
    // the SCRIPT that ran, not an artefact worth re-rendering.
    if (kind === "image" || kind === "pdf" || kind === "csv") out.push(p);
  }
  return out;
}

/**
 * The chat-rail descriptor for a tool call, or null to leave it plain.
 *
 * `toolName` arrives as the rail's DISPLAY name ("Write", "Bash"), so matching is
 * case-insensitive — comparing against lowercase silently disabled every rich
 * render the first time round.
 */
export function fileOutputFor(toolName, primary, output) {
  const name = String(toolName || "").toLowerCase();
  if (name === "write" || name === "edit") {
    const path = String(primary || "").trim();
    if (!path) return null;
    const kind = fileKind(path);
    if (!kind) return null;
    return { path, kind, ext: extOf(path), lang: langOf(path), name: path.split(/[\\/]/).pop() || path, verify: false };
  }
  if (name === "bash") {
    // Prefer the first image: if a command emitted both a chart and a csv, the
    // chart is what someone wants to see.
    const cands = candidatePaths(`${primary || ""} ${output || ""}`);
    const best = cands.find((c) => fileKind(c) === "image") || cands[0];
    if (!best) return null;
    const kind = fileKind(best);
    return { path: best, kind, ext: extOf(best), lang: langOf(best), name: best.split(/[\\/]/).pop() || best, verify: true };
  }
  return null;
}

/** First `rows` records of a CSV, split on commas outside double quotes. */
export function parseCsv(text, rows = 6) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (out.length >= rows) break;
    if (!line.trim()) continue;
    const cells = [];
    let cur = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { cells.push(cur); cur = ""; }
      else cur += c;
    }
    cells.push(cur);
    out.push(cells);
  }
  return out;
}

// Turn a unified diff (the `detail` an edit tool.end carries — createPatch hunk
// lines with headers stripped) into aligned left/right rows for a two-pane viewer.
// Deletions land on the left, additions on the right, context on both, each with
// its real line number. Pure string→data (authored as .js like chatgroups.js) so
// the same code the bundle uses is unit-testable in Node offline.

function parseHunkHeader(line) {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return { oldStart: Number(m[1]), newStart: Number(m[2]) };
}

export function parseUnifiedDiff(detail) {
  const rows = [];
  let oldLine = 1;
  let newLine = 1;
  let rem = [];
  let add = [];

  // Pair a run of deletions with the following run of additions: same-index lines
  // sit on the same row (a change); leftovers get their own row (pure del/add).
  const flush = () => {
    const n = Math.max(rem.length, add.length);
    for (let i = 0; i < n; i++) {
      const l = i < rem.length ? { num: oldLine++, text: rem[i] } : null;
      const r = i < add.length ? { num: newLine++, text: add[i] } : null;
      rows.push({ left: l, right: r, type: l ? "del" : "add" });
    }
    rem = [];
    add = [];
  };

  for (const raw of detail.split("\n")) {
    const hunk = parseHunkHeader(raw);
    if (hunk) { flush(); oldLine = hunk.oldStart; newLine = hunk.newStart; continue; }
    if (raw === "") { flush(); continue; } // blank separator between joined hunks
    const tag = raw[0];
    const body = raw.slice(1);
    if (tag === "-") { rem.push(body); continue; }
    if (tag === "+") { add.push(body); continue; }
    flush();
    const text = tag === " " ? body : raw;
    rows.push({ left: { num: oldLine++, text }, right: { num: newLine++, text }, type: "context" });
  }
  flush();
  return rows;
}

/** hljs language id guessed from a file path's extension (best-effort). */
export function langFromPath(path) {
  const ext = (/\.([a-z0-9]+)$/i.exec(path) || [])[1];
  if (!ext) return undefined;
  const e = ext.toLowerCase();
  const map = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", c: "c", h: "c", cpp: "cpp", cc: "cpp", cs: "csharp",
    json: "json", css: "css", scss: "scss", html: "xml", xml: "xml", md: "markdown", sh: "bash", bash: "bash",
    yml: "yaml", yaml: "yaml", sql: "sql", php: "php", swift: "swift", kt: "kotlin", toml: "ini", ini: "ini",
  };
  return map[e];
}

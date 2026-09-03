// Repo map: a tree-sitter-parsed, PageRank-ranked summary of the codebase's top
// symbols, injected into the system prompt so the model starts oriented. Grammars
// are loaded as WASM (web-tree-sitter + prebuilt tree-sitter-wasms) — no native
// build. Parses are cached in ~/.dom/cache/repomap.db keyed by path+mtime, so a
// second run only reparses changed files. A language with no grammar is skipped,
// never fatal.

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { cacheDir } from "./config.js";
import { runGlob } from "./tools/glob.js";

const require = createRequire(import.meta.url);

// extension → tree-sitter grammar name (a tree-sitter-<name>.wasm must exist).
const LANGS: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
};

// Definition queries per grammar (capture name = symbol kind). Reference queries
// capture every identifier so we can count inbound references per symbol name.
// TS/JS defs are anchored to the program root (directly or via an export_statement)
// so only MODULE-SCOPE symbols count — locals inside functions would swamp the map
// with noise (short names like `g`/`col` that collide across files).
const TS_DEFS = `
  (class_declaration name: (type_identifier) @class)
  (abstract_class_declaration name: (type_identifier) @class)
  (interface_declaration name: (type_identifier) @interface)
  (type_alias_declaration name: (type_identifier) @type)
  (enum_declaration name: (identifier) @enum)
  (function_declaration name: (identifier) @function)
  (lexical_declaration (variable_declarator name: (identifier) @const))`;
const JS_DEFS = `
  (class_declaration name: (identifier) @class)
  (function_declaration name: (identifier) @function)
  (lexical_declaration (variable_declarator name: (identifier) @const))`;
// Wrap each pattern so it only matches EXPORTED top-level declarations — the
// module's public API. This is the useful signal for a repo map, and it naturally
// excludes script scaffolding (the .mjs test files export nothing) whose common
// local names (`http`, `res`, `t0`) would otherwise collide with identifiers
// everywhere and dominate the ranking.
function topLevel(patterns: string): string {
  const each = patterns.trim().split(/\n\s*(?=\()/);
  return each.map((p) => `(program (export_statement ${p}))`).join("\n");
}
const DEF_QUERIES: Record<string, string> = {
  ts: topLevel(TS_DEFS),
  js: topLevel(JS_DEFS),
  python: `(module (function_definition name: (identifier) @function))
           (module (class_definition name: (identifier) @class))
           (module (decorated_definition (function_definition name: (identifier) @function)))
           (module (decorated_definition (class_definition name: (identifier) @class)))`,
  rust: `(function_item name: (identifier) @function)
         (struct_item name: (type_identifier) @struct)
         (enum_item name: (type_identifier) @enum)
         (trait_item name: (type_identifier) @trait)`,
  go: `(function_declaration name: (identifier) @function)
       (method_declaration name: (field_identifier) @method)
       (type_declaration (type_spec name: (type_identifier) @type))`,
  java: `(class_declaration name: (identifier) @class)
         (interface_declaration name: (identifier) @interface)
         (method_declaration name: (identifier) @method)`,
};
const REF_QUERIES: Record<string, string> = {
  ts: `(identifier) @ref (type_identifier) @ref (property_identifier) @ref`,
  js: `(identifier) @ref (property_identifier) @ref`,
  python: `(identifier) @ref`,
  rust: `(identifier) @ref (type_identifier) @ref`,
  go: `(identifier) @ref (type_identifier) @ref (field_identifier) @ref`,
  java: `(identifier) @ref (type_identifier) @ref`,
};
// typescript/tsx share the ts queries; javascript/jsx share js.
function queryFamily(grammar: string): string {
  if (grammar === "typescript" || grammar === "tsx") return "ts";
  if (grammar === "javascript") return "js";
  return grammar;
}

interface Def {
  name: string;
  kind: string;
  line: number;
}
interface FileParse {
  mtimeMs: number;
  defs: Def[];
  refs: Record<string, number>;
}

// --- tree-sitter loading (lazy, cached, degrades to skip) ---------------------

let TS: any = null;
let tsInit = false;
let parser: any = null;
const grammars = new Map<string, { lang: any; def: any; ref: any } | null>();

function wasmDir(): string | null {
  try {
    return path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
  } catch {
    return null;
  }
}

async function getGrammar(grammar: string): Promise<{ lang: any; def: any; ref: any } | null> {
  if (grammars.has(grammar)) return grammars.get(grammar)!;
  try {
    if (!tsInit) {
      TS = require("web-tree-sitter");
      await TS.init();
      parser = new TS();
      tsInit = true;
    }
    const dir = wasmDir();
    const wasm = dir ? path.join(dir, `tree-sitter-${grammar}.wasm`) : "";
    if (!wasm || !existsSync(wasm)) {
      grammars.set(grammar, null); // no grammar installed → skip this language
      return null;
    }
    const lang = await TS.Language.load(wasm);
    const fam = queryFamily(grammar);
    const def = lang.query(DEF_QUERIES[fam] ?? DEF_QUERIES.ts);
    const ref = lang.query(REF_QUERIES[fam] ?? REF_QUERIES.ts);
    const entry = { lang, def, ref };
    grammars.set(grammar, entry);
    return entry;
  } catch {
    grammars.set(grammar, null); // load/compile failed → skip, never fatal
    return null;
  }
}

function parseSource(grammar: string, g: { lang: any; def: any; ref: any }, source: string): { defs: Def[]; refs: Record<string, number> } {
  parser.setLanguage(g.lang);
  const tree = parser.parse(source);
  const defs: Def[] = [];
  const seen = new Set<string>();
  for (const c of g.def.captures(tree.rootNode)) {
    const name = c.node.text;
    const key = `${name}@${c.node.startPosition.row}`;
    if (seen.has(key)) continue;
    seen.add(key);
    defs.push({ name, kind: c.name, line: c.node.startPosition.row + 1 });
  }
  const refs: Record<string, number> = {};
  for (const c of g.ref.captures(tree.rootNode)) {
    const n = c.node.text;
    refs[n] = (refs[n] ?? 0) + 1;
  }
  tree.delete?.();
  return { defs, refs };
}

// --- cache --------------------------------------------------------------------

function dbPath(): string {
  return path.join(cacheDir(), "repomap.db");
}
async function loadDb(): Promise<Record<string, FileParse>> {
  try {
    return JSON.parse(await fs.readFile(dbPath(), "utf8"));
  } catch {
    return {};
  }
}
async function saveDb(db: Record<string, FileParse>): Promise<void> {
  try {
    await fs.mkdir(cacheDir(), { recursive: true });
    await fs.writeFile(dbPath(), JSON.stringify(db), "utf8");
  } catch {
    /* cache is best-effort */
  }
}

// --- PageRank -----------------------------------------------------------------

function pageRank(nodes: string[], edges: Map<string, Map<string, number>>): Map<string, number> {
  const N = nodes.length;
  const d = 0.85;
  let rank = new Map(nodes.map((n) => [n, 1 / N]));
  const outWeight = new Map<string, number>();
  for (const n of nodes) {
    let s = 0;
    for (const w of edges.get(n)?.values() ?? []) s += w;
    outWeight.set(n, s);
  }
  for (let iter = 0; iter < 30; iter++) {
    const next = new Map(nodes.map((n) => [n, (1 - d) / N]));
    let dangling = 0;
    for (const n of nodes) {
      const out = outWeight.get(n) ?? 0;
      if (out === 0) dangling += rank.get(n)! / N;
      else for (const [to, w] of edges.get(n) ?? []) next.set(to, next.get(to)! + (d * rank.get(n)! * w) / out);
    }
    if (dangling) for (const n of nodes) next.set(n, next.get(n)! + d * dangling);
    rank = next;
  }
  return rank;
}

// --- build --------------------------------------------------------------------

export interface RepoMap {
  text: string;
  tokens: number;
  parsed: number; // files parsed this run (missed the cache)
  cached: number; // files served from cache
  files: number;
  /** All parsed source files, most-central first (PageRank order) — relative,
   * POSIX-style paths. Drives @-file completion ranking. */
  rankedFiles: string[];
}

const estTokens = (s: string) => Math.ceil(s.length / 4);

/** Build the ranked repo map for `cwd`, serialized under `budgetTokens`. */
export async function buildRepoMap(cwd: string, budgetTokens = 1024): Promise<RepoMap> {
  // Enumerate source files honoring the ignore list (glob skips node_modules,
  // dist, .git, .dom, .gitignore matches, …). Resolve against the passed cwd, not
  // the global process cwd (they can differ per tab after the cwd-threading change).
  const glob = await runGlob({ pattern: "**/*" }, undefined, { cwd });
  const rel = glob.isError ? [] : glob.output.split("\n").map((l) => l.split("\t")[0]!).filter(Boolean);
  const files = rel.map((p) => path.resolve(cwd, p)).filter((p) => LANGS[path.extname(p).toLowerCase()]);

  const db = await loadDb();
  const fresh: Record<string, FileParse> = {};
  let parsed = 0;
  let cached = 0;

  for (const abs of files) {
    let mtimeMs = 0;
    try {
      mtimeMs = (await fs.stat(abs)).mtimeMs;
    } catch {
      continue;
    }
    const prev = db[abs];
    if (prev && prev.mtimeMs === mtimeMs) {
      fresh[abs] = prev;
      cached++;
      continue;
    }
    const grammar = LANGS[path.extname(abs).toLowerCase()]!;
    const g = await getGrammar(grammar);
    if (!g) {
      fresh[abs] = { mtimeMs, defs: [], refs: {} }; // language skipped — cache the empty parse
      continue;
    }
    try {
      const src = await fs.readFile(abs, "utf8");
      const { defs, refs } = parseSource(grammar, g, src);
      fresh[abs] = { mtimeMs, defs, refs };
      parsed++;
    } catch {
      fresh[abs] = { mtimeMs, defs: [], refs: {} };
    }
  }
  // Merge, not replace: `fresh` only covers files under THIS cwd, but the same
  // cache file is shared by every repo/tab. Replacing it wholesale silently
  // evicted every other cwd's entries on their next read, forcing a full
  // reparse there — not a correctness bug, but it defeated the cache for
  // anyone working across more than one repo root.
  await saveDb({ ...db, ...fresh });

  // name → files defining it.
  const definedIn = new Map<string, string[]>();
  for (const abs of files) for (const dfn of fresh[abs]?.defs ?? []) {
    (definedIn.get(dfn.name) ?? definedIn.set(dfn.name, []).get(dfn.name)!).push(abs);
  }

  // File dependency graph: F → D weighted by how many symbols defined in D that F
  // references. PageRank ranks files; symbols inherit their file's rank × inbound refs.
  // Only a name defined in EXACTLY ONE file is a real cross-file dependency. A name
  // defined in many files (test helpers `ok`/`t0`, per-component `const g`/`col`) is
  // almost always referenced locally, so counting it would fabricate a dense clique
  // among unrelated files. Ambiguous names are ignored entirely.
  const unique = (name: string) => (definedIn.get(name)?.length ?? 0) === 1;

  const edges = new Map<string, Map<string, number>>();
  for (const F of files) {
    const refs = fresh[F]?.refs ?? {};
    for (const [name, count] of Object.entries(refs)) {
      if (!unique(name)) continue;
      const D = definedIn.get(name)![0]!;
      if (D === F) continue;
      const m = edges.get(F) ?? edges.set(F, new Map()).get(F)!;
      m.set(D, (m.get(D) ?? 0) + count);
    }
  }
  const rank = pageRank(files, edges);

  // Inbound references to a (uniquely-defined) symbol name, from OTHER files.
  const inbound = (name: string, home: string) => {
    let s = 0;
    for (const F of files) if (F !== home) s += fresh[F]?.refs?.[name] ?? 0;
    return s;
  };
  interface Ranked extends Def {
    file: string;
    score: number;
  }
  const ranked: Ranked[] = [];
  for (const abs of files) {
    const r = rank.get(abs) ?? 0;
    for (const dfn of fresh[abs]?.defs ?? []) {
      if (!unique(dfn.name)) continue; // ambiguous name → treat as local, skip
      const ib = inbound(dfn.name, abs);
      if (ib <= 0) continue; // "top symbols by REFERENCE rank" — skip the unreferenced
      ranked.push({ ...dfn, file: abs, score: r * ib });
    }
  }
  ranked.sort((a, b) => b.score - a.score);

  // Serialize top symbols under the token budget, grouped by file (best-first).
  const rl = (abs: string) => path.relative(cwd, abs).split(path.sep).join("/");
  const header = "Repo map (top symbols by reference rank; not exhaustive):";
  const byFile = new Map<string, Ranked[]>();
  const order: string[] = [];
  let tokens = estTokens(header);
  for (const sym of ranked) {
    const line = `  ${sym.kind} ${sym.name}  L${sym.line}`;
    const headerCost = byFile.has(sym.file) ? 0 : estTokens(`${rl(sym.file)}:`);
    const cost = estTokens(line) + headerCost;
    if (tokens + cost > budgetTokens) break;
    tokens += cost;
    if (!byFile.has(sym.file)) {
      byFile.set(sym.file, []);
      order.push(sym.file);
    }
    byFile.get(sym.file)!.push(sym);
  }

  const out: string[] = [header];
  for (const f of order) {
    out.push(`${rl(f)}:`);
    for (const s of byFile.get(f)!.sort((a, b) => a.line - b.line)) out.push(`  ${s.kind} ${s.name}  L${s.line}`);
  }
  const text = byFile.size ? out.join("\n") : "";
  // Full PageRank-ordered file list (not budget-truncated like the text) for
  // @-completion ranking.
  const rankedFiles = [...files]
    .sort((a, b) => (rank.get(b) ?? 0) - (rank.get(a) ?? 0))
    .map((abs) => path.relative(cwd, abs).split(path.sep).join("/"));
  return { text, tokens: text ? estTokens(text) : 0, parsed, cached, files: files.length, rankedFiles };
}

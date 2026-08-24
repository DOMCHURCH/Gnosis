// LSP Lite: pick the right type checker for the files a turn edited, and count the
// errors in its output. Pure + unit-tested; the engine supplies the project markers
// (which config files exist) and runs the chosen command. A checker runs only when
// its project marker is present, so we never fire tsc/mypy/cargo in an unrelated repo.

export type Lang = "ts" | "python" | "rust";

export interface LspCheck {
  lang: Lang;
  label: string;
  command: string;
}

export interface Markers {
  tsconfig: boolean; // tsconfig.json
  cargo: boolean;    // Cargo.toml
  python: boolean;   // pyproject.toml / setup.py / setup.cfg / mypy.ini
}

const EXT_LANG: Record<string, Lang> = {
  ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts",
  ".py": "python", ".pyi": "python",
  ".rs": "rust",
};

/** The set of type-checkable languages among the edited files. */
export function editedLangs(paths: string[]): Set<Lang> {
  const s = new Set<Lang>();
  for (const p of paths) {
    const dot = p.lastIndexOf(".");
    if (dot < 0) continue;
    const l = EXT_LANG[p.slice(dot).toLowerCase()];
    if (l) s.add(l);
  }
  return s;
}

function quote(p: string): string {
  return /[\s"']/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p;
}

/**
 * Choose the type check to run after an editing turn. Priority TS → Rust → Python.
 * Each language runs only when BOTH a file of that language was edited AND the
 * project marker exists. Returns null when nothing applies.
 */
export function chooseLsp(paths: string[], markers: Markers): LspCheck | null {
  const langs = editedLangs(paths);
  if (langs.has("ts") && markers.tsconfig) {
    return { lang: "ts", label: "type check (tsc)", command: "npx --no-install tsc --noEmit" };
  }
  if (langs.has("rust") && markers.cargo) {
    return { lang: "rust", label: "type check (cargo)", command: "cargo check --quiet" };
  }
  if (langs.has("python") && markers.python) {
    const files = paths.filter((p) => /\.pyi?$/i.test(p)).map(quote).join(" ");
    return { lang: "python", label: "type check (mypy)", command: `mypy --ignore-missing-imports ${files}` };
  }
  return null;
}

/** Count the type errors in a checker's output. Prefers the tool's own summary
 * line, falling back to counting per-error markers. */
export function countLspErrors(lang: Lang, output: string): number {
  if (lang === "ts") {
    const m = output.match(/Found (\d+) error/);
    if (m) return Number(m[1]);
    return (output.match(/error TS\d+/g) ?? []).length;
  }
  if (lang === "python") {
    const m = output.match(/Found (\d+) error/);
    if (m) return Number(m[1]);
    return (output.match(/: error:/g) ?? []).length;
  }
  // rust
  const m = output.match(/aborting due to (\d+) previous error/);
  if (m) return Number(m[1]);
  return (output.match(/^error(\[[A-Z0-9]+\])?:/gm) ?? []).length;
}

// @-autocomplete file search for the web view: glob the tab's cwd (respecting the
// default ignores) and rank matches for `query`. Shared by TUI-serve (App) and
// headless serve (servehost) so both give the browser the same suggestions.

import { runGlob } from "./tools/glob.js";

export async function rankedFiles(cwd: string, query: string, limit = 20): Promise<string[]> {
  let paths: string[];
  try {
    const res = await runGlob({ pattern: "**/*" }, undefined, { cwd });
    if (res.isError) return [];
    paths = res.output.split("\n").map((l) => l.split("\t")[0]!).filter(Boolean);
  } catch {
    return [];
  }
  const q = query.trim().toLowerCase();
  if (!q) return paths.slice(0, limit); // glob is newest-first
  const base = (p: string) => p.slice(p.lastIndexOf("/") + 1).toLowerCase();
  const scored = paths
    .map((p) => {
      const lp = p.toLowerCase();
      const b = base(p);
      let score = -1;
      if (b.startsWith(q)) score = 0;
      else if (b.includes(q)) score = 1;
      else if (lp.includes(q)) score = 2;
      return { p, score };
    })
    .filter((s) => s.score >= 0)
    .sort((a, b) => a.score - b.score || a.p.length - b.p.length);
  return scored.slice(0, limit).map((s) => s.p);
}

// Verify (1.6 — @-file autocomplete): fuzzy subsequence scoring/filtering and the
// repo-map rank tiebreak. (The rankedFiles data source that feeds the ranking is
// verified in s4-repomap, alongside the rest of buildRepoMap.)
import { fuzzyScore, fuzzyFilter } from "../dist/fuzzy.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

// --- fuzzyScore --------------------------------------------------------------
ok("a subsequence match scores non-null", fuzzyScore("eng", "src/engine.ts") !== null);
ok("a non-subsequence returns null", fuzzyScore("xyz", "src/engine.ts") === null);
ok("empty query scores 0 (matches anything)", fuzzyScore("", "whatever") === 0);
ok("contiguous match outscores scattered", fuzzyScore("engine", "src/engine.ts") > fuzzyScore("egnie", "src/engine.ts"));
ok("a boundary (path-segment) match is favored", fuzzyScore("app", "src/App.tsx") > fuzzyScore("app", "src/mapper.ts"));

// --- fuzzyFilter -------------------------------------------------------------
{
  const items = [
    { value: "src/engine.ts", label: "src/engine.ts", search: "src/engine.ts", rank: 0 },
    { value: "src/ui/App.tsx", label: "src/ui/App.tsx", search: "src/ui/App.tsx", rank: 5 },
    { value: "README.md", label: "README.md", search: "README.md" },
  ];
  ok("empty query returns items unchanged (caller's rank order)", fuzzyFilter(items, "").length === 3 && fuzzyFilter(items, "")[0].value === "src/engine.ts");
  const eng = fuzzyFilter(items, "eng");
  ok("query 'eng' matches engine.ts and drops non-matches", eng.length === 1 && eng[0].value === "src/engine.ts");
  const app = fuzzyFilter(items, "app");
  ok("query 'app' finds App.tsx", app.some((i) => i.value === "src/ui/App.tsx"));
  // rank tiebreak: two equally-fuzzy targets, lower rank wins
  const tie = fuzzyFilter([
    { value: "b/x.ts", label: "b/x.ts", search: "b/x.ts", rank: 9 },
    { value: "a/x.ts", label: "a/x.ts", search: "a/x.ts", rank: 1 },
  ], "x.ts");
  ok("equal fuzzy scores break ties on repo-map rank (lower first)", tie[0].value === "a/x.ts");
}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

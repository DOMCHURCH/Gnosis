// Verify (feature 8 — repo map): on the dom repo the map is under budget and names
// the tool registry + engine; a warm second run is materially faster (parses
// nothing); touching one file reparses only that file. Cache isolated to a fresh
// fake home so the first run is genuinely cold.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { buildRepoMap } = await import("../dist/repomap.js");

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

// --- on the dom repo: under budget, includes the tool registry + engine --------
const repo = process.cwd();
const t0 = Date.now();
const a = await buildRepoMap(repo, 1024);
const t1 = Date.now() - t0;
ok("the map stays under the token budget", a.tokens > 0 && a.tokens <= 1024);
ok("the first (cold) run parses files", a.parsed > 0 && a.cached === 0);
ok("the map includes the tool registry (TOOLS)", /const TOOLS/.test(a.text) && /src\/tools\/index\.ts/.test(a.text));
ok("the map includes the engine (class Engine)", /class Engine/.test(a.text) && /src\/engine\.ts/.test(a.text));
ok("symbols are grouped by file with line numbers", /\bL\d+/.test(a.text));
ok("rankedFiles (for @-completion) is a non-empty list of the repo's central files", Array.isArray(a.rankedFiles) && a.rankedFiles.includes("src/engine.ts"));

const t0b = Date.now();
const b = await buildRepoMap(repo, 1024);
const t2 = Date.now() - t0b;
ok("a warm second run reparses nothing (all cached)", b.parsed === 0 && b.cached === a.files);
ok(`the warm run is materially faster (${t1}ms → ${t2}ms)`, t2 < t1);
ok("the warm map is identical", b.text === a.text);

// --- touching one file reparses only that file ---------------------------------
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dom-map-"));
const prevCwd = process.cwd();
process.chdir(dir);
await fs.mkdir(path.join(dir, "src"));
await fs.writeFile(path.join(dir, "src", "a.ts"), "export function helper() { return 1; }\nexport const VALUE = 2;\n");
await fs.writeFile(path.join(dir, "src", "b.ts"), 'import { helper, VALUE } from "./a.js";\nexport function main() { return helper() + VALUE; }\n');

const c1 = await buildRepoMap(dir, 1024);
ok("a small project parses all its files first", c1.parsed === 2 && c1.cached === 0);
ok("rankedFiles orders a referenced file (a.ts) before its referencer (b.ts)", c1.rankedFiles.indexOf("src/a.ts") !== -1 && c1.rankedFiles.indexOf("src/a.ts") < c1.rankedFiles.indexOf("src/b.ts"));
const c2 = await buildRepoMap(dir, 1024);
ok("re-running parses nothing", c2.parsed === 0 && c2.cached === 2);
// bump one file's mtime (content unchanged) — the cache keys on path+mtime
await fs.utimes(path.join(dir, "src", "a.ts"), new Date(Date.now() + 10000), new Date(Date.now() + 10000));
const c3 = await buildRepoMap(dir, 1024);
ok("touching one file reparses ONLY that file", c3.parsed === 1 && c3.cached === 1);

// --- the cache is shared across cwds: it merges, it does not replace -----------
// repomap.db is one file under the (fake) home, keyed by absolute path, used by
// every cwd. Building the map for `dir` just now must not have evicted the
// entries this suite already cached for `repo` above — a wholesale
// save-what-I-saw-this-run overwrite would silently do exactly that, forcing
// every OTHER open project to reparse from cold on its next map.
process.chdir(prevCwd);
const d = await buildRepoMap(repo, 1024);
ok("building a DIFFERENT cwd's map does not evict this repo's cache entries", d.parsed === 0 && d.cached === a.files);

await fs.rm(dir, { recursive: true, force: true });
await fs.rm(fake, { recursive: true, force: true });
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

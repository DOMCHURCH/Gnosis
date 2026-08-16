// Verify (feature 6 — /init): generating AGENTS.md for the dom repo names
// TypeScript, Ink, the npm scripts, and the src layout; the doc is prose and under
// 60 lines; writing refuses to overwrite an existing AGENTS.md without --force.
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const { generateAgentsMd, writeAgentsMd } = await import("../dist/init.js");

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

// --- generate for the dom repo (this suite runs with cwd = repo root) ----------
const doc = await generateAgentsMd(process.cwd());
ok("names the language (TypeScript)", /TypeScript/.test(doc));
ok("names the framework (Ink)", /Ink/.test(doc));
ok("includes the build command (npm run build)", /npm run build/.test(doc));
ok("includes the test command (npm run verify)", /npm run verify/.test(doc));
ok("describes the src/ layout", /`src\/`/.test(doc));
ok("describes the verify/ layout", /`verify\/`/.test(doc));
ok("is prose with sections, not a raw file listing", /## Stack/.test(doc) && /## Layout/.test(doc) && /## Conventions/.test(doc));
ok("stays under 60 lines", doc.split("\n").length < 60);

// --- refuse to overwrite an existing AGENTS.md without --force ------------------
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dom-init-"));
await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "demo", type: "module", scripts: { build: "tsc", test: "vitest" }, dependencies: { react: "^18" }, devDependencies: { typescript: "^5", vitest: "^1" } }));
await fs.mkdir(path.join(dir, "src"));

const first = await writeAgentsMd(dir, false);
ok("first /init writes AGENTS.md", first.written && existsSync(path.join(dir, "AGENTS.md")));
ok("the generated file is under 60 lines", first.lineCount < 60);

const second = await writeAgentsMd(dir, false);
ok("a second /init refuses to overwrite", !second.written && /--force/.test(second.reason ?? ""));

await fs.writeFile(path.join(dir, "AGENTS.md"), "hand-edited\n");
const forced = await writeAgentsMd(dir, true);
ok("/init --force overwrites", forced.written && !(await fs.readFile(path.join(dir, "AGENTS.md"), "utf8")).startsWith("hand-edited"));
ok("detection works on other stacks (React + Vitest)", /React/.test(await fs.readFile(path.join(dir, "AGENTS.md"), "utf8")) && /Vitest/.test(await fs.readFile(path.join(dir, "AGENTS.md"), "utf8")));

await fs.rm(dir, { recursive: true, force: true });
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

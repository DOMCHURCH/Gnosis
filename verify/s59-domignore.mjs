// Verify (file browser cleanup): the shared ignorer + buildTree hide dom/Playwright
// temp files (screenshots, website-named files, .playwright-mcp/) and honor a
// .domignore, without deleting anything; the glob tool respects the same rules.
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const { buildIgnorer } = await import("../dist/tools/ignore.js");
const { buildTree } = await import("../dist/filetree.js");
const { runGlob } = await import("../dist/tools/glob.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dom-di-"));
await fs.writeFile(path.join(dir, "keep.ts"), "export const x = 1;\n");
await fs.writeFile(path.join(dir, "test.png"), "x");
await fs.writeFile(path.join(dir, "shot.jpg"), "x");
await fs.writeFile(path.join(dir, "amazon-cart.md"), "x");
await fs.writeFile(path.join(dir, "github-pr.md"), "x");
await fs.writeFile(path.join(dir, "notes.md"), "x");
await fs.writeFile(path.join(dir, "test.csv"), "a,b\n");
await fs.mkdir(path.join(dir, ".playwright-mcp"), { recursive: true });
await fs.writeFile(path.join(dir, ".playwright-mcp", "trace.md"), "x");

const names = async () => {
  const t = await buildTree(dir, { ignore: buildIgnorer(dir, false) });
  return t.tree.map((n) => n.name);
};

// --- auto-excludes ---------------------------------------------------------------
let n = await names();
ok("real source files remain", n.includes("keep.ts") && n.includes("notes.md"));
ok("a .png is hidden from the browser", !n.includes("test.png"));
ok("a .jpg is hidden from the browser", !n.includes("shot.jpg"));
ok("a website-named file (amazon-) is hidden", !n.includes("amazon-cart.md"));
ok("a website-named file (github-) is hidden", !n.includes("github-pr.md"));
ok("the .playwright-mcp dir is hidden", !n.includes(".playwright-mcp"));
ok("test.csv is visible without a .domignore", n.includes("test.csv"));

// nothing was deleted — only hidden
ok("hidden files still exist on disk (never deleted)", existsSync(path.join(dir, "test.png")) && existsSync(path.join(dir, "amazon-cart.md")));

// --- .domignore ------------------------------------------------------------------
await fs.writeFile(path.join(dir, ".domignore"), "*.csv\n");
n = await names();
ok(".domignore *.csv hides test.csv", !n.includes("test.csv"));
ok(".domignore does not affect unrelated files", n.includes("keep.ts"));

// removing .domignore restores the file
await fs.rm(path.join(dir, ".domignore"));
n = await names();
ok("removing .domignore restores test.csv", n.includes("test.csv"));

// --- glob honors the same rules --------------------------------------------------
const g = await runGlob({ pattern: "**/*" }, undefined, { cwd: dir });
ok("glob hides png/website/.playwright-mcp by default", !/test\.png|amazon-cart|\.playwright-mcp/.test(g.output) && /keep\.ts/.test(g.output));
const gAll = await runGlob({ pattern: "**/*.png", include_ignored: true }, undefined, { cwd: dir });
ok("glob include_ignored: true opts back in", /test\.png/.test(gAll.output));

await fs.rm(dir, { recursive: true, force: true });
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

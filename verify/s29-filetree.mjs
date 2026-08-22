// Verify (File Browser tree walk + preview guard). buildTree skips the noise dirs
// (.git, node_modules, dist, .dom), nests real dirs, sorts dirs-before-files, and
// caps huge trees. readFileInRoot reads inside the root but REFUSES to escape it
// via ../ traversal — the guard that keeps the browser inside the session's cwd.
// The DOM rendering (panel, modal) is browser-only and not covered here.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const { buildTree, readFileInRoot, EXCLUDED_DIRS } = await import("../dist/filetree.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

const root = await fs.mkdtemp(path.join(os.tmpdir(), "dom-tree-"));
// Layout:
//   a.txt
//   src/index.ts
//   src/util/deep.ts
//   node_modules/pkg/x.js   (excluded)
//   .git/HEAD               (excluded)
//   dist/out.js             (excluded)
//   .dom/state.json         (excluded)
await fs.writeFile(path.join(root, "a.txt"), "hello");
await fs.mkdir(path.join(root, "src", "util"), { recursive: true });
await fs.writeFile(path.join(root, "src", "index.ts"), "export const x = 1;");
await fs.writeFile(path.join(root, "src", "util", "deep.ts"), "// SECRET line\nconst y = 2;\n");
for (const d of ["node_modules/pkg", ".git", "dist", ".dom"]) {
  await fs.mkdir(path.join(root, d), { recursive: true });
  await fs.writeFile(path.join(root, d, "f.js"), "noise");
}

try {
  const { tree, cwd, truncated } = await buildTree(root);
  ok("returns the root cwd", cwd === root);
  ok("not truncated for a small tree", truncated === false);

  const names = tree.map((n) => n.name);
  ok("excludes .git / node_modules / dist / .dom", !names.some((n) => EXCLUDED_DIRS.has(n)));
  // dirs sort before files → src (dir) precedes a.txt (file).
  ok("dirs sort before files", tree[0].type === "dir" && tree[0].name === "src" && names.includes("a.txt"));

  const src = tree.find((n) => n.name === "src");
  ok("src is a dir with children", src && src.type === "dir" && Array.isArray(src.children));
  ok("nested path uses forward slashes", src.children.some((c) => c.name === "index.ts" && c.path === "src/index.ts"));
  const util = src.children.find((n) => n.name === "util");
  ok("descends into nested dirs", util && util.children.some((c) => c.path === "src/util/deep.ts"));

  // preview: reads a real file inside root
  const prev = await readFileInRoot(root, "src/util/deep.ts");
  ok("reads a file inside root", prev && prev.content.includes("const y = 2;") && prev.truncated === false);
  ok("preview path is normalized", prev && prev.path === "src/util/deep.ts");

  // traversal guard: must refuse to escape root
  const escaped = await readFileInRoot(root, "../../../../etc/passwd");
  ok("refuses ../ traversal outside root", escaped === null);
  const abs = await readFileInRoot(root, path.join(root, "..", path.basename(root) + "-sibling"));
  ok("refuses a sibling dir sharing the prefix", abs === null);
  const missing = await readFileInRoot(root, "does-not-exist.ts");
  ok("returns null for a missing file", missing === null);

  // entry cap → truncated flag
  const capped = await buildTree(root, { maxEntries: 2 });
  ok("hitting the entry cap sets truncated", capped.truncated === true);
} catch (e) {
  ok(`filetree completed (${e.message})`, false);
}

try { await fs.rm(root, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

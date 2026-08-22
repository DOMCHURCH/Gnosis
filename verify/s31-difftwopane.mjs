// Verify (side-by-side diff parse). parseUnifiedDiff turns the createPatch hunk
// lines an edit tool.end carries into aligned left/right rows: deletions left,
// additions right, context on both, with real line numbers. The DOM rendering +
// highlight.js are browser-only and not covered here.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { parseUnifiedDiff, langFromPath } = await import(pathToFileURL(path.resolve(here, "../web/src/difftwopane.js")).href);

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// A one-line change inside two context lines.
const diff = ["@@ -1,3 +1,3 @@", " const a = 1;", "-const b = 2;", "+const b = 3;", " const c = 4;"].join("\n");
const rows = parseUnifiedDiff(diff);

ok("context lines appear on both sides", rows[0].left.text === "const a = 1;" && rows[0].right.text === "const a = 1;" && rows[0].type === "context");
ok("a change pairs deletion(left) with addition(right)", rows[1].type === "del" && rows[1].left.text === "const b = 2;" && rows[1].right.text === "const b = 3;");
ok("line numbers track old vs new", rows[0].left.num === 1 && rows[1].left.num === 2 && rows[1].right.num === 2 && rows[2].left.num === 3 && rows[2].right.num === 3);

// Pure insertion: left cell null, right present.
const ins = ["@@ -1,1 +1,2 @@", " x", "+y"].join("\n");
const irows = parseUnifiedDiff(ins);
ok("a pure insertion has no left cell", irows[1].left === null && irows[1].right.text === "y" && irows[1].type === "add");

// Pure deletion: right cell null.
const del = ["@@ -1,2 +1,1 @@", " x", "-gone"].join("\n");
const drows = parseUnifiedDiff(del);
ok("a pure deletion has no right cell", drows[1].right === null && drows[1].left.text === "gone" && drows[1].type === "del");

// Multiple hunks separated by a blank line keep independent numbering.
const multi = ["@@ -1,1 +1,1 @@", "-a", "+A", "", "@@ -10,1 +10,1 @@", "-b", "+B"].join("\n");
const mrows = parseUnifiedDiff(multi);
ok("second hunk resumes at its own line numbers", mrows[mrows.length - 1].left.num === 10 && mrows[mrows.length - 1].right.num === 10);

ok("langFromPath maps extensions", langFromPath("src/x.ts") === "typescript" && langFromPath("a.py") === "python" && langFromPath("noext") === undefined);

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

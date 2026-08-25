// Verify (rich file output): the extension classifier routes each written file to
// the right rail treatment, the CSV splitter handles quoted cells, and the raw
// file endpoint keeps the file browser's traversal guard.
import { fileKind, langOf, fileOutputFor, parseCsv, extOf, candidatePaths } from "../web/src/filekind.js";
import { resolveInRoot, RAW_MIME } from "../dist/filetree.js";
import { groupChat } from "../web/src/chatgroups.js";
import path from "node:path";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

// --- classification -----------------------------------------------------------
ok("png is an image", fileKind("out/chart.png") === "image");
ok("svg is an image (not code)", fileKind("logo.svg") === "image");
ok("ts is code", fileKind("src/app.ts") === "code");
ok("py is code", fileKind("train.py") === "code");
ok("json is its own kind (not code)", fileKind("package.json") === "json");
ok("csv is its own kind", fileKind("data.csv") === "csv");
ok("pdf is its own kind", fileKind("report.pdf") === "pdf");
ok("an unknown extension falls back to generic", fileKind("archive.zip") === "generic");
ok("no extension renders nothing rich", fileKind("Makefile") === null);

ok("ts maps to the typescript highlighter", langOf("a.ts") === "typescript");
ok("html maps to xml (hljs has no bare html)", langOf("a.html") === "xml");
ok("extOf is case-insensitive", extOf("CHART.PNG") === ".png");
ok("uppercase extensions still classify", fileKind("CHART.PNG") === "image");

// --- only successful writes/edits get rich output -----------------------------
ok("write of a png produces a descriptor", fileOutputFor("write", "out/chart.png")?.kind === "image");
ok("edit of a ts file produces a descriptor", fileOutputFor("edit", "src/a.ts")?.kind === "code");
ok("a read is never rich", fileOutputFor("read", "src/a.ts") === null);
ok("a bash call is never rich", fileOutputFor("bash", "ls") === null);
ok("an empty path is never rich", fileOutputFor("write", "  ") === null);
ok("the descriptor carries the basename", fileOutputFor("write", "deep/dir/chart.png")?.name === "chart.png");
ok("a windows path also yields the basename", fileOutputFor("write", "deep\\dir\\chart.png")?.name === "chart.png");

// --- CSV preview --------------------------------------------------------------
const rows = parseCsv("a,b,c\n1,2,3\n4,5,6\n7,8,9\n", 3);
ok("csv splits into rows", rows.length === 3);
ok("csv splits into cells", rows[0].join("|") === "a|b|c");
const quoted = parseCsv('name,note\n"Church, D","said ""hi"""\n');
ok("a quoted comma stays in one cell", quoted[1][0] === "Church, D");
ok("a doubled quote unescapes", quoted[1][1] === 'said "hi"');
ok("blank lines are skipped", parseCsv("a,b\n\n1,2\n").length === 2);

// --- the raw endpoint's guard is the file browser's guard ----------------------
const root = path.resolve("C:/tmp/root");
ok("a path inside the root resolves", resolveInRoot(root, "sub/file.png") !== null);
ok("../ escape is refused", resolveInRoot(root, "../secrets.env") === null);
ok("a deep ../ escape is refused", resolveInRoot(root, "a/b/../../../secrets.env") === null);
ok("an absolute path outside the root is refused", resolveInRoot(root, "C:/Windows/system.ini") === null);
// The classic prefix bug: …/root-evil must not pass a plain startsWith(…/root).
ok("a sibling sharing the root's prefix is refused", resolveInRoot(root, "../root-evil/x") === null);

ok("png has an image mime", RAW_MIME[".png"] === "image/png");
ok("pdf has its own mime", RAW_MIME[".pdf"] === "application/pdf");
ok("an unlisted type has no mime (served as a download)", RAW_MIME[".zip"] === undefined);

// --- the rail passes the DISPLAY tool name ("Write", not "write") -------------
// Comparing against lowercase silently disabled every rich render the first time.
ok("the display name Write is matched", fileOutputFor("Write", "a.ts")?.kind === "code");
ok("the display name Edit is matched", fileOutputFor("Edit", "a.ts")?.kind === "code");
ok("a write descriptor needs no verification", fileOutputFor("Write", "a.png")?.verify === false);

// --- a chart is written by a SCRIPT, so bash output must be scanned -----------
const fromBash = fileOutputFor("Bash", "py make_chart.py", "wrote output.png, 1778 bytes");
ok("a png named in bash output is detected", fromBash?.path === "output.png" && fromBash.kind === "image");
ok("...and is marked for existence verification", fromBash.verify === true);
ok("an image wins over a csv in the same command", fileOutputFor("Bash", "run.sh", "wrote data.csv and chart.png")?.kind === "image");
ok("a bash call producing nothing renderable stays plain", fileOutputFor("Bash", "ls -la", "total 4") === null);
ok("the script itself is not re-rendered as output", fileOutputFor("Bash", "python make_chart.py", "done") === null);

ok("candidatePaths finds several", candidatePaths("made out/a.png and b.csv").length === 2);
ok("candidatePaths strips a leading ./", candidatePaths("wrote ./out.png")[0] === "out.png");
ok("candidatePaths ignores unknown extensions", candidatePaths("wrote thing.zip").length === 0);
ok("candidatePaths dedupes", candidatePaths("a.png then a.png again").length === 1);

// --- groupChat must not drop per-kind payloads ---------------------------------
// Its final projection is an explicit whitelist; a field added to a group but
// forgotten there is silently dropped before the rail ever sees it. That bug shipped
// once and cost three features their web rendering, so it is pinned here.
{
  const groups = groupChat([
    { key: "t1", tabId: 1, from: "x", kind: "tool", epoch: 1, time: "0", tool: "Bash", primary: "py s.py", ok: true, summary: "wrote output.png 1210 bytes", detail: "" },
    { key: "q1", tabId: 1, from: "x", kind: "ask", epoch: 1, time: "0", askId: "a1", question: "A or B?", options: ["A", "B"] },
    { key: "o1", tabId: 1, from: "x", kind: "outcome", epoch: 1, time: "0", text: "x", verdict: "fail", confidence: 71 },
  ]);
  ok("a tool group survives grouping", groups[0]?.kind === "tool");
  ok("fileOutput survives the projection", groups[0]?.fileOutput?.path === "output.png");
  ok("an ask group keeps its id and options", groups[1]?.askId === "a1" && groups[1]?.options?.length === 2);
  ok("an outcome group keeps its verdict and confidence", groups[2]?.verdict === "fail" && groups[2]?.confidence === 71);
}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

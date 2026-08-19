// Verify: compact tool-call rendering. Call signatures, per-tool result summaries,
// left-truncation, the 4-calls-under-12-lines compactness, full errors, /verbose.
import { callParts, callLine, leftTruncate, summarizeResult, resultBody, toolEntryLines } from "../dist/ui/toolrender.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };
const eq = (name, got, want) => ok(`${name} (${JSON.stringify(got)})`, got === want);

// --- call signatures --------------------------------------------------------
eq("read → Read(path)", `${callParts("read", { path: "src/engine.ts" }).tool}(${callParts("read", { path: "src/engine.ts" }).primary})`, "Read(src/engine.ts)");
{
  const e = callParts("edit", { path: "src/App.tsx", replace_all: true });
  eq("edit replace_all → secondary shown", e.tool + "(" + e.primary + e.secondary + ")", "Edit(src/App.tsx, replace_all)");
  eq("edit without replace_all → no secondary", callParts("edit", { path: "x" }).secondary, "");
}
eq("bash → Bash(command)", callParts("bash", { command: "npm run build" }).primary, "npm run build");
{
  const h = callParts("http", { method: "get", url: "https://api.example.com/v1/x" });
  eq("http → METHOD host/path, scheme stripped", `${h.tool}(${h.primary})`, "Http(GET api.example.com/v1/x)");
}
eq("web_search → query as primary", callParts("web_search", { query: "brave api" }).primary, "brave api");
eq("view_image → path as primary", callParts("view_image", { path: "shots/a.png" }).primary, "shots/a.png");
{
  const t = callParts("todo", { items: [{ text: "a", status: "done" }, { text: "b", status: "active" }] });
  eq("todo → N tasks", `${t.tool}(${t.primary})`, "Todo(2 tasks)");
  const e = callParts("edit", { path: "f.ts", edits: [{ old_str: "a", new_str: "b" }, { old_str: "c", new_str: "d" }] });
  eq("edit batch → shows edit count", e.primary + e.secondary, "f.ts, 2 edits");
}

// --- left-truncation of long paths ------------------------------------------
{
  const long = "src/very/deeply/nested/directory/structure/file.ts";
  const t = leftTruncate(long, 20);
  ok("long path truncates from the LEFT (keeps the tail)", t.startsWith("…") && long.endsWith(t.slice(1)) && t.length === 20);
  const cl = callLine(callParts("read", { path: long }), 30);
  ok("call line fits the width budget", cl.length <= 30 && cl.startsWith("● Read(…") && cl.endsWith("file.ts)"));
}

// --- per-tool result summaries ----------------------------------------------
const readOut = ["     1  line one", "     2  line two", "     3  line three"].join("\n") + "\n... (56 more lines)";
eq("read summary", summarizeResult("read", {}, readOut), "Read 3 lines");
eq("write summary → lines + basename", summarizeResult("write", { path: "a/b/hello.py" }, "Wrote 402 bytes (23 lines) to a/b/hello.py"), "Wrote 23 lines to hello.py");
eq("edit summary → diff of old/new", summarizeResult("edit", { old_str: "a\nb", new_str: "a\nX\nY\nZ\nW\nV" }, "Edited f — 1 replacement"), "Added 5 lines, removed 1 line");
eq("grep summary", summarizeResult("grep", {}, ["src/a.ts:1:x", "src/a.ts:9:y", "src/b.ts:3:z"].join("\n")), "3 matches in 2 files");
eq("grep no matches", summarizeResult("grep", {}, "No matches for /zzz/"), "No matches");
eq("glob summary", summarizeResult("glob", {}, ["a.ts\t10", "b.ts\t20", "c.ts\t30"].join("\n")), "3 files");
{
  const httpOut = ["GET api.example.com/x", "> user-agent: dom", "", "200 OK", "< content-type: application/json; charset=utf-8", "< content-length: 4300", "", '{"a":1}'].join("\n");
  eq("http summary → status · size type", summarizeResult("http", {}, httpOut), "200 OK · 4.2KB json");
}
eq("web_search summary → N results", summarizeResult("web_search", {}, `3 results for "x":\n\n1. A\n   https://a`), "3 results");
eq("web_search summary → no results", summarizeResult("web_search", {}, 'No results for "zzz".'), "No results");
eq("edit batch summary → prefixed with edit count", summarizeResult("edit", { edits: [{ old_str: "a", new_str: "A" }, { old_str: "b", new_str: "B" }] }, "Edited f — 2 edits, 2 replacements"), "2 edits · Added 2 lines, removed 2 lines");
{
  const bashOut = "l1\nl2\nl3\nl4\nl5";
  eq("bash summary → first 3 lines + marker", summarizeResult("bash", {}, bashOut), "l1\nl2\nl3\n+2 lines");
  eq("bash short → verbatim", summarizeResult("bash", {}, "only\ntwo"), "only\ntwo");
}

// --- compactness: 4 tool calls render in under 12 lines ---------------------
{
  const entries = [
    { ...callParts("read", { path: "src/engine.ts" }), body: summarizeResult("read", {}, readOut) },
    { ...callParts("edit", { path: "src/App.tsx" }), body: summarizeResult("edit", { old_str: "a\nb", new_str: "a\nc\nd" }, "Edited f — 1 replacement") },
    { ...callParts("bash", { command: "npm run build" }), body: summarizeResult("bash", {}, "compiled ok") },
    { ...callParts("grep", { pattern: "TODO" }), body: summarizeResult("grep", {}, "src/a.ts:1:TODO") },
  ];
  const total = entries.reduce((sum, e) => sum + toolEntryLines(e, 80).length, 0);
  ok(`4 tool calls render in ${total} lines (< 12)`, total < 12);
}

// --- errors show full text; /verbose restores full output -------------------
const failOut = "read: ENOENT: no such file or directory, open 'missing.txt'\n(check the path)";
eq("a failing tool shows its FULL error (not summarized)", resultBody({ isError: true, verbose: false, name: "read", args: {}, output: failOut }), failOut);
eq("/verbose restores full output", resultBody({ isError: false, verbose: true, name: "read", args: {}, output: readOut }), readOut);
eq("default (no error, no verbose) → summarized", resultBody({ isError: false, verbose: false, name: "read", args: {}, output: readOut }), "Read 3 lines");

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

// Verify (chat message grouping) — the SAME chatgroups.js the browser bundle uses.
// Consecutive same-speaker/same-turn lines collapse into one block; a ``` fence
// becomes a monospace code segment kept verbatim; speaker/turn changes split;
// user messages and approvals are their own sealed blocks. The DOM rendering
// (bordered code box) needs a live browser and is NOT covered here.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { groupChat, resolveApproval } = await import(pathToFileURL(path.resolve(here, "../web/src/chatgroups.js")).href);

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

const L = (over) => ({ key: "k", from: "main", kind: "assistant", epoch: 0, time: "10:00", ...over });

// 1) six consecutive assistant lines in one turn → ONE block, one text segment.
{
  const lines = Array.from({ length: 6 }, (_, i) => L({ key: `a${i}`, text: `line ${i}` }));
  const g = groupChat(lines);
  ok("consecutive same-speaker/same-turn lines make one block", g.length === 1);
  ok("...joined into a single text segment", g[0].segments.length === 1 && g[0].segments[0].type === "text" && g[0].segments[0].text === "line 0\nline 1\nline 2\nline 3\nline 4\nline 5");
}

// 2) a fenced code block renders as one code segment, verbatim, with its language.
{
  const lines = [
    L({ key: "t", text: "here is code:" }),
    L({ key: "o", rule: "open", lang: "ts" }),
    L({ key: "c1", text: "const x = 1;" }),
    L({ key: "c2", text: "  return x;" }),
    L({ key: "cl", rule: "close" }),
    L({ key: "t2", text: "done." }),
  ];
  const g = groupChat(lines);
  ok("prose + code + prose stays one block", g.length === 1);
  ok("...as three segments (text, code, text)", g[0].segments.map((s) => s.type).join(",") === "text,code,text");
  ok("the code segment keeps its language + verbatim indentation", g[0].segments[1].lang === "ts" && g[0].segments[1].text === "const x = 1;\n  return x;");
  ok("prose is not merged into the code segment", g[0].segments[0].text === "here is code:" && g[0].segments[2].text === "done.");
}

// 3) speaker change splits blocks.
{
  const g = groupChat([L({ key: "a", from: "main", text: "hi" }), L({ key: "b", from: "worker", text: "yo" })]);
  ok("a speaker change starts a new block", g.length === 2 && g[0].from === "main" && g[1].from === "worker");
}

// 4) a new turn (epoch) splits blocks even for the same speaker.
{
  const g = groupChat([L({ key: "a", epoch: 0, text: "turn one" }), L({ key: "b", epoch: 1, text: "turn two" })]);
  ok("a new turn starts a new block", g.length === 2);
}

// 5) a user message is its own sealed block (assistant after it doesn't merge in).
{
  const g = groupChat([L({ key: "u", from: "YOU", kind: "user", text: "do it" }), L({ key: "a", text: "on it" })]);
  ok("a user message is its own block", g.length === 2 && g[0].from === "YOU" && g[0].segments[0].text === "do it");
}

// 6) an approval is its own block carrying permId + isApproval.
{
  const g = groupChat([L({ key: "p1", kind: "approval", text: "Needs approval: rm -rf", permId: "1:2" })]);
  ok("an approval is its own block with permId", g.length === 1 && g[0].isApproval === true && g[0].permId === "1:2");
}

// 7) empty/whitespace-only groups are dropped (no blank bubbles).
{
  const g = groupChat([L({ key: "blank", text: "   " })]);
  ok("a whitespace-only line produces no bubble", g.length === 0);
}

// 8) a tool call is its own block carrying the compact parts + full detail.
{
  const g = groupChat([L({ key: "t1", kind: "tool", tool: "Write", primary: "greet.py", secondary: "", ok: true, summary: "Wrote 9 lines to greet.py", detail: "print('hi')\n" })]);
  ok("a tool call is its own block", g.length === 1 && g[0].kind === "tool");
  ok("the tool block keeps the compact call parts + summary", g[0].tool.tool === "Write" && g[0].tool.primary === "greet.py" && g[0].tool.summary === "Wrote 9 lines to greet.py");
  ok("the tool block carries the full detail for expansion", g[0].tool.detail === "print('hi')\n" && g[0].tool.ok === true);
}

// 9) resolveApproval rewrites the pending card to its outcome, in place.
{
  const lines = [L({ key: "p1", kind: "approval", text: "Needs approval: write greet.py", permId: "1:2", label: "write greet.py" })];
  const approved = resolveApproval(lines, "1:2", "yes");
  ok("resolveApproval marks it resolved with the outcome text", approved[0].resolved === "yes" && approved[0].text === "approved: write greet.py");
  const denied = resolveApproval(lines, "1:2", "no");
  ok("a 'no' answer denies", denied[0].resolved === "no" && denied[0].text === "denied: write greet.py");
  ok("an unrelated id leaves the card untouched", resolveApproval(lines, "9:9", "yes")[0].resolved === undefined);
  // a resolved card surfaces through groupChat with its outcome + no pending buttons.
  const g = groupChat(approved);
  ok("a resolved approval groups with resolved set (styled as outcome, no buttons)", g.length === 1 && g[0].isApproval === true && g[0].resolved === "yes" && g[0].segments[0].text === "approved: write greet.py");
}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

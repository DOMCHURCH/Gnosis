// Verify (streaming file edits): a large edit streams its new content line-by-line
// and writes to disk only at commit; aborting mid-stream leaves the file untouched;
// small edits keep the atomic path; and at the engine level the permission prompt
// fires BEFORE any edit.start (streaming begins only after approval).
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { runEdit } = await import("../dist/tools/edit.js");
const { Engine } = await import("../dist/engine.js");
const { createSession } = await import("../dist/config.js");
const { EventBus } = await import("../dist/events.js");

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dom-edit-"));
const big = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
const bigNew = Array.from({ length: 20 }, (_, i) => (i === 5 ? "line 5 CHANGED" : `line ${i}`)).join("\n");

// --- streaming path: events + write-only-at-commit ------------------------------
{
  const f = path.join(dir, "big.txt");
  await fs.writeFile(f, big);
  const events = [];
  let contentAtStart = null;
  const stream = {
    start: (p, original, totalLines) => events.push({ k: "start", p, totalLines }),
    line: async (index, text, changed) => { if (index === 0) contentAtStart = await fs.readFile(f, "utf8"); events.push({ k: "line", index, changed }); },
    commit: (p, ok2) => events.push({ k: "commit", ok: ok2 }),
  };
  const res = await runEdit({ path: f, old_str: "line 5", new_str: "line 5 CHANGED" }, undefined, { cwd: dir, editStream: stream });
  ok("streaming edit succeeds", !res.isError);
  ok("edit.start fired once with the new line count (20)", events.filter((e) => e.k === "start").length === 1 && events.find((e) => e.k === "start").totalLines === 20);
  ok("one edit.line per new line (20)", events.filter((e) => e.k === "line").length === 20);
  ok("only the changed line is flagged changed", events.filter((e) => e.k === "line" && e.changed).length === 1 && events.find((e) => e.k === "line" && e.changed).index === 5);
  ok("nothing was written to disk mid-stream (still original at first line)", contentAtStart === big);
  ok("edit.commit fired with ok:true", events.some((e) => e.k === "commit" && e.ok === true));
  ok("the file on disk has the new content after commit", (await fs.readFile(f, "utf8")) === bigNew);
}

// --- abort mid-stream: nothing written -----------------------------------------
{
  const f = path.join(dir, "abort.txt");
  await fs.writeFile(f, big);
  const ac = new AbortController();
  let committed = null;
  const stream = {
    start: () => {},
    line: (index) => { if (index === 3) ac.abort(); }, // Ctrl+C partway through
    commit: (p, ok2) => { committed = ok2; },
  };
  const res = await runEdit({ path: f, old_str: "line 5", new_str: "line 5 CHANGED" }, ac.signal, { cwd: dir, editStream: stream });
  ok("an aborted streaming edit reports aborted", res.isError && res.aborted);
  ok("the file is left completely unchanged after an abort", (await fs.readFile(f, "utf8")) === big);
  ok("edit.commit signals failure (ok:false) on abort", committed === false);
}

// --- small edit keeps the atomic path (no streaming events) ---------------------
{
  const f = path.join(dir, "small.txt");
  await fs.writeFile(f, "a\nb\nc\n");
  let streamed = false;
  const stream = { start: () => { streamed = true; }, line: () => { streamed = true; }, commit: () => { streamed = true; } };
  const res = await runEdit({ path: f, old_str: "b", new_str: "B" }, undefined, { cwd: dir, editStream: stream });
  ok("a small edit (<10 lines) still succeeds", !res.isError);
  ok("a small edit does NOT stream (atomic path)", streamed === false);
  ok("a small edit writes the new content", (await fs.readFile(f, "utf8")) === "a\nB\nc\n");
}

// --- no stream channel (headless) → atomic even for a large edit ----------------
{
  const f = path.join(dir, "headless.txt");
  await fs.writeFile(f, big);
  const res = await runEdit({ path: f, old_str: "line 5", new_str: "line 5 CHANGED" }, undefined, { cwd: dir });
  ok("a large edit with no stream channel writes atomically", !res.isError && (await fs.readFile(f, "utf8")) === bigNew);
}

// --- engine level: permission prompt fires BEFORE any edit.start ----------------
{
  const gitless = await fs.mkdtemp(path.join(os.tmpdir(), "dom-editeng-"));
  const f = path.join(gitless, "code.ts");
  await fs.writeFile(f, big);
  const model = { id: "anthropic/claude-sonnet-4.6", name: "S", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"] };
  const sse = (b) => new Response(b, { status: 200, headers: { "content-type": "text/event-stream" } });
  const usage = `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":50,"completion_tokens":10,"cost":0.001}}\n\ndata: [DONE]\n\n`;
  const textSSE = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n${usage}`;
  const toolSSE = (name, a) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name, arguments: JSON.stringify(a) } }] } }] })}\n\n${usage}`;
  // read (satisfies read-before-edit) → edit → done
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return sse(toolSSE("read", { path: f }));
    if (calls === 2) return sse(toolSSE("edit", { path: f, old_str: "line 5", new_str: "line 5 CHANGED" }));
    return sse(textSSE("done"));
  };

  const engine = new Engine({ apiKey: "test", cwd: gitless, systemPrompt: "SYS", models: [model], session: createSession(gitless, model.id, "ask"), skills: [], autoCommit: false });
  engine.interactive = true;
  const bus = new EventBus();
  engine.bus = bus;
  const order = [];
  bus.subscribe((e) => { if (e.type === "edit.start") order.push("edit.start"); if (e.type === "edit.line") order.push("edit.line"); if (e.type === "edit.commit") order.push("edit.commit"); });

  let permAt = -1;
  await engine.run("go", {
    onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult() {}, onSystem() {},
    requestPermission: async () => { permAt = order.length; return "yes"; }, // record how many edit.* events preceded approval
  });
  ok("streaming produced edit.start/line/commit on the bus", order.includes("edit.start") && order.filter((x) => x === "edit.line").length === 20 && order.includes("edit.commit"));
  ok("the permission prompt fired BEFORE any streaming event", permAt === 0 && order[0] === "edit.start");
  ok("after approval the file on disk holds the new content", (await fs.readFile(f, "utf8")) === bigNew);
  await fs.rm(gitless, { recursive: true, force: true });
}

await fs.rm(dir, { recursive: true, force: true });
await fs.rm(fake, { recursive: true, force: true });
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

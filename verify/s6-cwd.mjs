// Verify (cwd threading): tools resolve paths against the engine's own cwd (via
// ctx.cwd), never the global process.cwd(), and nothing chdirs. Three scenarios:
//   1. two "tabs" (engines) in different dirs resolve the SAME relative path to
//      their OWN file, with interleaved (concurrent) turns and process.cwd()
//      pointed at a third, unrelated directory;
//   2. a sub-agent searches its parent's root while process.cwd() points elsewhere;
//   3. aborting a sub-agent mid-run leaves process.cwd() unchanged.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { Engine } = await import("../dist/engine.js");
const { createSession } = await import("../dist/config.js");

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const sse = (b) => new Response(b, { status: 200, headers: { "content-type": "text/event-stream" } });
const usage = `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n`;
const textSSE = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n${usage}`;
const toolSSE = (name, args) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n${usage}`;
const done = textSSE("done");

const model = (id) => ({ id, name: id, context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"], input_modalities: ["text"] });
const mkEngine = (cwd, sys) => new Engine({ apiKey: "test", cwd, systemPrompt: sys, models: [model("m")], session: createSession(cwd, "m", "yolo"), skills: [], autoCommit: false });
const cbCollect = (arr) => ({ onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult(_c, r) { arr.push(r); }, onSystem() {}, async requestPermission() { return "yes"; } });

const dirA = await fs.mkdtemp(path.join(os.tmpdir(), "dom-A-"));
const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "dom-B-"));
const dirC = await fs.mkdtemp(path.join(os.tmpdir(), "dom-C-")); // unrelated; where process.cwd() sits
await fs.writeFile(path.join(dirA, "marker.txt"), "I am A\n");
await fs.writeFile(path.join(dirB, "marker.txt"), "I am B\n");
await fs.writeFile(path.join(dirA, "needle.txt"), "UNIQ_MARKER_A lives here\n");

const originalCwd = process.cwd();
process.chdir(dirC); // process.cwd() is now a directory that contains NEITHER marker.txt

// --- 1) two tabs, different dirs, interleaved turns, same relative path -------
{
  const served = { A: false, B: false };
  globalThis.fetch = async (_u, init) => {
    const sys = String(JSON.parse(init.body).messages[0].content);
    const which = sys.startsWith("AAA") ? "A" : "B";
    if (!served[which]) { served[which] = true; return sse(toolSSE("read", { path: "marker.txt" })); }
    return sse(done);
  };
  const engA = mkEngine(dirA, "AAA system");
  const engB = mkEngine(dirB, "BBB system");
  const outA = [], outB = [];
  // Run BOTH turns concurrently — interleaved tool resolution must not clash.
  await Promise.all([engA.run("go", cbCollect(outA)), engB.run("go", cbCollect(outB))]);
  ok("tab A resolved marker.txt against its own cwd (dirA)", !!outA[0] && !outA[0].isError && /I am A/.test(outA[0].output));
  ok("tab B resolved marker.txt against its own cwd (dirB)", !!outB[0] && !outB[0].isError && /I am B/.test(outB[0].output));
  ok("neither tab leaked the other's file (independent cwds)", !/I am B/.test(outA[0].output) && !/I am A/.test(outB[0].output));
  ok("process.cwd() stayed at the unrelated dir the whole time", process.cwd() === dirC);
}

// --- 2) sub-agent searches the PARENT's root, process.cwd() elsewhere --------
{
  globalThis.fetch = async (_u, init) => {
    const msgs = JSON.parse(init.body).messages;
    if (/research sub-agent/i.test(String(msgs[0].content))) {
      const lastTool = [...msgs].reverse().find((m) => m.role === "tool");
      if (!lastTool) return sse(toolSSE("grep", { pattern: "UNIQ_MARKER_A" }));
      return sse(textSSE(`FOUND: ${String(lastTool.content).slice(0, 200)}`));
    }
    return sse(done);
  };
  const parent = mkEngine(dirA, "PARENT system"); // parent root = dirA
  const res = await parent.runSubAgent("find the marker", "grep for UNIQ_MARKER_A and report the file");
  ok("sub-agent searched the parent's cwd (found needle.txt in dirA)", /needle\.txt/.test(res.text) && /UNIQ_MARKER_A/.test(res.text));
  ok("...even though process.cwd() points at an unrelated dir", process.cwd() === dirC);
}

// --- 3) aborting a sub-agent mid-run leaves no cwd change behind -------------
{
  // A fetch that hangs until the request's own signal aborts (never resolves).
  globalThis.fetch = async (_u, init) => {
    const sig = init.signal;
    return new Promise((_resolve, reject) => {
      if (sig?.aborted) return reject(new DOMException("Aborted", "AbortError"));
      sig?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  };
  const parent = mkEngine(dirA, "PARENT system");
  const before = process.cwd();
  const ac = new AbortController();
  const p = parent.runSubAgent("hang", "this will be aborted", ac.signal);
  await new Promise((r) => setTimeout(r, 60));
  ac.abort(); // abort the sub-agent mid-run
  const res = await p; // must resolve (not throw) after the abort
  ok("aborting a sub-agent resolves cleanly (no throw)", !!res && typeof res.text === "string");
  ok("process.cwd() is unchanged after aborting a sub-agent mid-run", process.cwd() === before);
}

process.chdir(originalCwd);
await fs.rm(dirA, { recursive: true, force: true });
await fs.rm(dirB, { recursive: true, force: true });
await fs.rm(dirC, { recursive: true, force: true });
await fs.rm(fake, { recursive: true, force: true });
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

// Verify (2.1 — auto lint/test loop): with autoFix on, after an editing turn the
// engine runs the configured lint/test; a non-zero exit is fed back and the model
// retries; it succeeds once the code is fixed. A perpetually-failing check stops
// after 3 attempts. Disabled by default (no checks run).
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;
const writeCfg = (o) => fs.writeFile(path.join(fake, ".dom", "config.json"), JSON.stringify(o));
await fs.mkdir(path.join(fake, ".dom"), { recursive: true });

const { Engine } = await import("../dist/engine.js");
const { createSession } = await import("../dist/config.js");

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const sse = (b) => new Response(b, { status: 200, headers: { "content-type": "text/event-stream" } });
const u = `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n`;
const textSSE = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n${u}`;
const toolSSE = (name, args) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n${u}`;

const model = { id: "m", name: "M", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"], input_modalities: ["text"] };
const run = async (engine, script) => {
  let n = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    return sse(script(n++, engine));
  };
  const sys = [];
  await engine.run("go", { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult() {}, onSystem(t) { sys.push(t); }, async requestPermission() { return "yes"; } });
  return sys;
};

// --- fix loop succeeds after feedback ---------------------------------------
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dom-af-"));
  await fs.writeFile(path.join(dir, "code.txt"), "NEEDS_FIX\nTODO\n");
  // lint fails (exit 1) while NEEDS_FIX is present.
  await writeCfg({ autoFix: true, lintCommand: "grep -q NEEDS_FIX code.txt && exit 1 || exit 0" });
  const engine = new Engine({ apiKey: "test", cwd: dir, systemPrompt: "t", models: [model], session: createSession(dir, "m", "yolo"), skills: [], autoCommit: false });
  // 0: read, 1: harmless edit (NEEDS_FIX remains), 2: text → lint fails → feedback,
  // 3: fix edit (removes NEEDS_FIX), 4: text → lint passes.
  const sys = await run(engine, (n) => {
    if (n === 0) return toolSSE("read", { path: "code.txt" });
    if (n === 1) return toolSSE("edit", { path: "code.txt", old_str: "TODO", new_str: "TODO2" });
    if (n === 2) return textSSE("edited");
    if (n === 3) return toolSSE("edit", { path: "code.txt", old_str: "NEEDS_FIX\n", new_str: "" });
    return textSSE("fixed it");
  });
  const content = await fs.readFile(path.join(dir, "code.txt"), "utf8");
  ok("the failing check fed a fix request back into history", engine.messages.some((m) => m.role === "user" && /Automated checks failed/.test(m.text) && /NEEDS_FIX/.test(m.text)));
  ok("the model got to retry (a fix attempt was announced)", sys.some((t) => /fix attempt 1\/3/.test(t)));
  ok("the fix landed and the checks then passed", !content.includes("NEEDS_FIX") && sys.some((t) => /checks pass/.test(t)));
  await fs.rm(dir, { recursive: true, force: true });
}

// --- perpetual failure stops after 3 attempts -------------------------------
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dom-af2-"));
  await writeCfg({ autoFix: true, lintCommand: "exit 1" }); // always fails
  const engine = new Engine({ apiKey: "test", cwd: dir, systemPrompt: "t", models: [model], session: createSession(dir, "m", "yolo"), skills: [], autoCommit: false });
  // Each segment: write a fresh file (exempt from read-before-edit) then text.
  const sys = await run(engine, (n) => (n % 2 === 0 ? toolSSE("write", { path: `f${n / 2}.txt`, content: "x" }) : textSSE("done")));
  ok("a perpetually-failing check stops after 3 attempts", sys.some((t) => /still failing after 3 fix attempts/.test(t)));
  ok("it announced attempts 1, 2, and 3", ["1/3", "2/3", "3/3"].every((a) => sys.some((t) => t.includes(`fix attempt ${a}`))));
  await fs.rm(dir, { recursive: true, force: true });
}

// --- disabled by default (autoFix off) --------------------------------------
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dom-af3-"));
  await writeCfg({ lintCommand: "exit 1" }); // configured but autoFix not set
  const engine = new Engine({ apiKey: "test", cwd: dir, systemPrompt: "t", models: [model], session: createSession(dir, "m", "yolo"), skills: [], autoCommit: false });
  const sys = await run(engine, (n) => (n === 0 ? toolSSE("write", { path: "a.txt", content: "x" }) : textSSE("done")));
  ok("with autoFix off, no checks run", !sys.some((t) => /fix attempt|checks/.test(t)));
  await fs.rm(dir, { recursive: true, force: true });
}

try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

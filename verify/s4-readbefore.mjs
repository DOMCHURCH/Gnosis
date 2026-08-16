// Verify (feature 2 — read-before-edit): editing an unread file errors ("read it
// first"); editing after an external modification forces a re-read; reading then
// editing works; creating a NEW file is exempt. autoCommit off (git not involved).
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { Engine } = await import("../dist/engine.js");
const { createSession } = await import("../dist/config.js");

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const sse = (body) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
const done = `data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n`;
const toolSSE = (name, args) =>
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n` +
  `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n`;

let pending = null;
let served = false;
globalThis.fetch = async () => {
  if (pending && !served) { served = true; return sse(toolSSE(pending.name, pending.args)); }
  return sse(done);
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dom-rb-"));
const prevCwd = process.cwd();
process.chdir(dir);
const model = { id: "anthropic/claude-sonnet-4.6", name: "S", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"] };
const engine = new Engine({ apiKey: "test", cwd: dir, systemPrompt: "t", models: [model], session: createSession(dir, model.id, "ask"), skills: [], autoCommit: false });

// Drive one tool call, return its ToolResult.
async function turn(name, args) {
  pending = { name, args }; served = false;
  const results = [];
  await engine.run("go", { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult(_c, r) { results.push(r); }, onSystem() {}, async requestPermission() { return "yes"; } });
  return results[0];
}

const file = path.join(dir, "file.txt");
await fs.writeFile(file, "line1\nline2\n");

// 1) edit a file that was never read this session → rejected
{
  const r = await turn("edit", { path: "file.txt", old_str: "line1", new_str: "LINE1" });
  ok("editing an unread file errors", r.isError && /read it first|haven't read/i.test(r.output));
  ok("...and the file is untouched", (await fs.readFile(file, "utf8")) === "line1\nline2\n");
}

// 2) read it, then edit → allowed
await turn("read", { path: "file.txt" });
{
  const r = await turn("edit", { path: "file.txt", old_str: "line1", new_str: "LINE1" });
  ok("reading then editing works", !r.isError && /Edited/.test(r.output));
  ok("...the edit landed", (await fs.readFile(file, "utf8")) === "LINE1\nline2\n");
}

// 3) external modification after read → forces a re-read
await fs.writeFile(file, "external\n");
await fs.utimes(file, new Date(Date.now() + 10000), new Date(Date.now() + 10000)); // guarantee a distinct mtime
{
  const r = await turn("edit", { path: "file.txt", old_str: "external", new_str: "X" });
  ok("an external change since the read forces a re-read", r.isError && /changed on disk/i.test(r.output));
  ok("...and the file is untouched", (await fs.readFile(file, "utf8")) === "external\n");
  // re-reading clears the staleness
  await turn("read", { path: "file.txt" });
  const r2 = await turn("edit", { path: "file.txt", old_str: "external", new_str: "CHANGED" });
  ok("re-reading then editing works again", !r2.isError && (await fs.readFile(file, "utf8")) === "CHANGED\n");
}

// 4) creating a brand-new file is exempt from the read requirement
{
  const r = await turn("write", { path: "brand-new.txt", content: "hello\n" });
  ok("creating a new file still works (no prior read needed)", !r.isError && existsSync(path.join(dir, "brand-new.txt")));
  // ...and overwriting an unread existing file is rejected
  await fs.writeFile(path.join(dir, "other.txt"), "x\n");
  const r2 = await turn("write", { path: "other.txt", content: "y\n" });
  ok("overwriting an unread existing file is rejected", r2.isError && /read it first|haven't read/i.test(r2.output));
}

process.chdir(prevCwd);
await fs.rm(dir, { recursive: true, force: true });
await fs.rm(fake, { recursive: true, force: true });
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

// Verify (feature 5 — hooks): a PreToolUse hook rejecting .env edits blocks the
// call and the model sees the reason; a PostToolUse hook runs after a write; a
// PreToolUse hook that sleeps 10s times out (5s) without blocking; project hooks
// shadow global; /hooks lists them.
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { Engine } = await import("../dist/engine.js");
const { createSession } = await import("../dist/config.js");
const { runPreToolUse, resolveHook, listHooks } = await import("../dist/hooks.js");

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

// --- write the hook scripts (portable node .mjs) -------------------------------
async function hook(dir, event, body) {
  await fs.mkdir(path.join(dir, ".dom", "hooks"), { recursive: true });
  await fs.writeFile(path.join(dir, ".dom", "hooks", `${event}.mjs`), body);
}
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dom-hooks-"));
await hook(dir, "PreToolUse", `let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const e=JSON.parse(d||"{}");const p=String(e.args?.path??"");if((e.tool==="edit"||e.tool==="write")&&p.includes(".env")){process.stderr.write("editing .env is forbidden by policy");process.exit(1);}process.exit(0);});`);
await hook(dir, "PostToolUse", `import{writeFileSync}from"node:fs";import path from"node:path";let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const e=JSON.parse(d||"{}");if(e.tool==="write")writeFileSync(path.join(process.cwd(),".postran"),"1");process.exit(0);});`);

// --- drive the engine in that dir ----------------------------------------------
const sse = (b) => new Response(b, { status: 200, headers: { "content-type": "text/event-stream" } });
const done = `data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n`;
const toolSSE = (name, args) =>
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n` +
  `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n`;
let pending = null, served = false;
globalThis.fetch = async () => { if (pending && !served) { served = true; return sse(toolSSE(pending.name, pending.args)); } return sse(done); };

const prevCwd = process.cwd();
process.chdir(dir);
await fs.writeFile(path.join(dir, ".env"), "SECRET=1\n");
const model = { id: "anthropic/claude-sonnet-4.6", name: "S", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"] };
const engine = new Engine({ apiKey: "test", cwd: dir, systemPrompt: "t", models: [model], session: createSession(dir, model.id, "ask"), skills: [], autoCommit: false });
async function turn(name, args) {
  pending = { name, args }; served = false;
  const results = [];
  await engine.run("go", { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult(_c, r) { results.push(r); }, onSystem() {}, async requestPermission() { return "yes"; } });
  return results[0];
}

// 1) PreToolUse blocks an .env edit; the model sees the reason
{
  const r = await turn("edit", { path: ".env", old_str: "SECRET=1", new_str: "SECRET=2" });
  ok("PreToolUse blocks the .env edit", r.isError);
  ok("...and the model sees the hook's reason (its stderr)", /forbidden by policy/.test(r.output));
  ok("...the .env is untouched", (await fs.readFile(path.join(dir, ".env"), "utf8")) === "SECRET=1\n");
}

// 2) PostToolUse runs after a write (here: drops a marker, standing in for prettier)
{
  const r = await turn("write", { path: "app.js", content: "console.log(1)\n" });
  ok("a normal write is allowed by PreToolUse", !r.isError && existsSync(path.join(dir, "app.js")));
  ok("PostToolUse ran after the write", existsSync(path.join(dir, ".postran")));
}
process.chdir(prevCwd);

// 3) a PreToolUse hook sleeping 10s times out (5s) without blocking
{
  const slow = await fs.mkdtemp(path.join(os.tmpdir(), "dom-slow-"));
  await hook(slow, "PreToolUse", `setTimeout(()=>process.exit(0),10000);`);
  const t0 = Date.now();
  const res = await runPreToolUse(slow, "read", { path: "x" });
  const dt = Date.now() - t0;
  ok("a slow PreToolUse hook returns at the 5s timeout (not 10s)", dt >= 4000 && dt < 8500);
  ok("...it does NOT block the call (times out → allow)", res.block === false);
  ok("...and warns about the timeout", /timed out/i.test(res.warn ?? ""));
  await fs.rm(slow, { recursive: true, force: true });
}

// 4) project hooks shadow global; /hooks lists them
{
  await fs.mkdir(path.join(fake, ".dom", "hooks"), { recursive: true });
  await fs.writeFile(path.join(fake, ".dom", "hooks", "PreToolUse.mjs"), "process.exit(0)");
  const ref = await resolveHook(dir, "PreToolUse");
  ok("project hook shadows the global one", ref && ref.scope === "project" && ref.path.startsWith(dir));
  const hs = await listHooks(dir);
  ok("/hooks lists the registered hooks", hs.some((h) => h.event === "PreToolUse") && hs.some((h) => h.event === "PostToolUse"));
}

await fs.rm(dir, { recursive: true, force: true });
await fs.rm(fake, { recursive: true, force: true });
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

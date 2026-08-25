// Verify (security scan → auto-commit gate), end to end through a real Engine
// turn: a write carrying a key-shaped string lands on disk, its auto-commit is
// blocked with the specified warning, the model is told without being shown the
// secret, and /commit --force releases it.
import { promises as fs } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "gnosis-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { Engine } = await import("../dist/engine.js");
const { createSession } = await import("../dist/config.js");
const { SECURITY_IGNORE_FILE } = await import("../dist/security.js");

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const KEY = "sk-test1234567890123456789012";
const sse = (b) => new Response(b, { status: 200, headers: { "content-type": "text/event-stream" } });
const usage = `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n`;
const textSSE = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n${usage}`;
const toolSSE = (name, args) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n${usage}`;

const repo = await fs.mkdtemp(path.join(os.tmpdir(), "gnosis-sec-"));
const git = (a) => execSync(`git ${a}`, { cwd: repo, stdio: "pipe" });
git("init -q"); git("config user.email x@y.z"); git("config user.name x");
await fs.writeFile(path.join(repo, "R.md"), "base\n");
git("add -A"); git("commit -qm init");
const headCount = () => Number(execSync("git rev-list --count HEAD", { cwd: repo }).toString().trim());
const commitsAtStart = headCount();

const model = { id: "m", name: "M", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"], input_modalities: ["text"] };

// --- turn 1: the agent writes a file containing a key ------------------------
let step = 0;
const steps = [toolSSE("write", { path: "leak.ts", content: `const key = "${KEY}";\n` }), textSSE("done")];
globalThis.fetch = async () => sse(steps[Math.min(step++, steps.length - 1)]);

const engine = new Engine({ apiKey: "test", cwd: repo, systemPrompt: "s", models: [model], session: createSession(repo, "m", "yolo"), skills: [], autoCommit: true });
const sys = [];
let toolOutput = "";
await engine.run("write the config", {
  onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {},
  onToolResult(_c, r) { toolOutput += r.output; },
  onSystem(t) { sys.push(t); },
  async requestPermission() { return "yes"; },
});

// The write must always stand — blocking a commit is recoverable, dropping work is not.
ok("the file was still written to disk", (await fs.readFile(path.join(repo, "leak.ts"), "utf8")).includes(KEY));

const warn = sys.find((t) => /security/.test(t)) ?? "";
ok("a security warning was emitted", !!warn);
ok("...naming the line number", /line 1/.test(warn));
ok("...and saying the commit was blocked", /auto-commit blocked/.test(warn));
ok("...without ever printing the secret", !warn.includes(KEY));

ok("auto-commit did NOT fire", headCount() === commitsAtStart);
ok("the file is left uncommitted in the tree", execSync("git status --porcelain", { cwd: repo }).toString().includes("leak.ts"));

// Rule 1: the model is told what and where, but never shown the value.
ok("the tool result tells the model it was blocked", /auto-commit was blocked/.test(toolOutput));
ok("...and never contains the secret", !toolOutput.includes(KEY));
ok("...and points at the exemption file", toolOutput.includes(SECURITY_IGNORE_FILE));

// --- /commit --force releases it ---------------------------------------------
ok("the blocked file is tracked for override", engine.blockedCommits.size === 1);
const done = await engine.forceBlockedCommits();
ok("--force commits the blocked file", done.includes("leak.ts"));
ok("...producing a real commit", headCount() === commitsAtStart + 1);
ok("...and clearing the block list", engine.blockedCommits.size === 0);
ok("...leaving the tree clean", !execSync("git status --porcelain", { cwd: repo }).toString().includes("leak.ts"));

// --- a clean write still auto-commits ----------------------------------------
{
  step = 0;
  const clean = [toolSSE("write", { path: "fine.ts", content: "export const x = 1;\n" }), textSSE("done")];
  globalThis.fetch = async () => sse(clean[Math.min(step++, clean.length - 1)]);
  const before = headCount();
  const sys2 = [];
  await engine.run("write a clean file", {
    onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult() {},
    onSystem(t) { sys2.push(t); }, async requestPermission() { return "yes"; },
  });
  ok("a clean file auto-commits as before", headCount() === before + 1);
  ok("...with no security warning", !sys2.some((t) => /security/.test(t)));
}

// --- an exempted path is not blocked ------------------------------------------
{
  await fs.writeFile(path.join(repo, SECURITY_IGNORE_FILE), "fixtures/\n", "utf8");
  await fs.mkdir(path.join(repo, "fixtures"), { recursive: true });
  step = 0;
  const ex = [toolSSE("write", { path: "fixtures/keys.ts", content: `const k = "${KEY}";\n` }), textSSE("done")];
  globalThis.fetch = async () => sse(ex[Math.min(step++, ex.length - 1)]);
  const before = headCount();
  const sys3 = [];
  await engine.run("write the fixture", {
    onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult() {},
    onSystem(t) { sys3.push(t); }, async requestPermission() { return "yes"; },
  });
  ok("an exempted fixture is not blocked", !sys3.some((t) => /security/.test(t)));
  ok("...and commits normally", headCount() === before + 1);
}

try { await fs.rm(repo, { recursive: true, force: true }); } catch {}
try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

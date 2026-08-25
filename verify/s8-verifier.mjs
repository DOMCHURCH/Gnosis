// Verify (2.2 — verifier subagent): after a multi-file change, runVerifier spawns
// a read-only subagent that sees ONLY the original request and the diff (never the
// generator's system prompt/reasoning), has NO tools, and returns a PASS/FAIL
// verdict + specifics. autoVerify runs it automatically on 2+ file turns.
import { promises as fs } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;
await fs.mkdir(path.join(fake, ".dom"), { recursive: true });

const { Engine } = await import("../dist/engine.js");
const { createSession } = await import("../dist/config.js");

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const sse = (b) => new Response(b, { status: 200, headers: { "content-type": "text/event-stream" } });
const uUsage = (u) => `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":${u.p},"completion_tokens":${u.c},"cost":${u.cost}}}\n\ndata: [DONE]\n\n`;
const textSSE = (t, u = { p: 5, c: 1, cost: 0 }) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n${uUsage(u)}`;
const toolSSE = (name, args) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n${uUsage({ p: 5, c: 1, cost: 0 })}`;

// a git repo with two committed files.
const repo = await fs.mkdtemp(path.join(os.tmpdir(), "dom-vr-"));
await fs.writeFile(path.join(repo, "a.txt"), "AAA\n");
await fs.writeFile(path.join(repo, "b.txt"), "BBB\n");
const git = (args) => execSync(`git ${args}`, { cwd: repo, stdio: "pipe" });
git("init -q"); git("config user.email x@y.z"); git("config user.name x"); git("add -A"); git("commit -qm init");

let verifierReq = null;
let verdictText = "PASS the changes satisfy the request.";
let gi = 0;
const genSteps = [
  toolSSE("read", { path: "a.txt" }),
  toolSSE("edit", { path: "a.txt", old_str: "AAA", new_str: "AAA2" }),
  toolSSE("read", { path: "b.txt" }),
  toolSSE("edit", { path: "b.txt", old_str: "BBB", new_str: "BBB2" }),
  textSSE("done"),
];
globalThis.fetch = async (_u, init) => {
  const body = JSON.parse(init.body);
  const sys = String(body.messages[0].content);
  if (/skeptical code reviewer/.test(sys)) {
    verifierReq = { system: sys, tools: body.tools, user: String(body.messages.find((m) => m.role === "user").content) };
    return sse(textSSE(verdictText, { p: 20, c: 5, cost: 0.01 }));
  }
  return sse(genSteps[Math.min(gi++, genSteps.length - 1)]);
};

const model = { id: "m", name: "M", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"], input_modalities: ["text"] };
const engine = new Engine({ apiKey: "test", cwd: repo, systemPrompt: "GENERATOR_SECRET_PROMPT — do the work", models: [model], session: createSession(repo, "m", "yolo"), skills: [], autoCommit: false });

// generator turn edits both files (autoVerify off by default → no auto run)
await engine.run("improve both files", { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult() {}, onSystem() {}, async requestPermission() { return "yes"; } });

// --- manual /verify path ----------------------------------------------------
{
  verdictText = "PASS the changes satisfy the request.";
  const v = await engine.runVerifier();
  ok("verifier returns a verdict", v && v.verdict === "pass");
  ok("verifier subagent used the skeptical-reviewer system prompt", verifierReq && /skeptical code reviewer/.test(verifierReq.system));
  ok("verifier saw NO tools", verifierReq && (!verifierReq.tools || verifierReq.tools.length === 0));
  ok("verifier saw the ORIGINAL request", verifierReq && verifierReq.user.includes("improve both files"));
  ok("verifier saw the DIFF (both files' changes)", verifierReq && /AAA2/.test(verifierReq.user) && /BBB2/.test(verifierReq.user) && /a\.txt/.test(verifierReq.user) && /b\.txt/.test(verifierReq.user));
  ok("verifier did NOT see the generator's system prompt / reasoning", verifierReq && !verifierReq.user.includes("GENERATOR_SECRET_PROMPT") && !verifierReq.system.includes("GENERATOR_SECRET_PROMPT"));
}

// --- FAIL verdict parsing ---------------------------------------------------
{
  verdictText = "FAIL b.txt was changed incorrectly and a.txt is incomplete.";
  const v = await engine.runVerifier();
  ok("a FAIL first line yields a fail verdict with specifics", v && v.verdict === "fail" && /incorrectly/.test(v.text));
}

// --- the outcome check runs automatically on a file-touching turn -----------
// `autoVerify` is the legacy switch; it must keep working after the rename to
// `autoEval`, because existing configs on disk still say autoVerify.
{
  await fs.writeFile(path.join(fake, ".dom", "config.json"), JSON.stringify({ autoVerify: true }));
  verdictText = "PASS all good.";
  gi = 0;
  await fs.writeFile(path.join(repo, "a.txt"), "AAA\n"); await fs.writeFile(path.join(repo, "b.txt"), "BBB\n"); // reset to HEAD content
  const eng2 = new Engine({ apiKey: "test", cwd: repo, systemPrompt: "gen", models: [model], session: createSession(repo, "m", "yolo"), skills: [], autoCommit: false });
  const sys = [];
  await eng2.run("improve both again", { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult() {}, onSystem(t) { sys.push(t); }, async requestPermission() { return "yes"; } });
  ok("the legacy autoVerify config still triggers the check", sys.some((t) => /evaluating the outcome/.test(t)));
  ok("...and the verdict is reported inline", sys.some((t) => /outcome:/.test(t)));
}

await fs.rm(repo, { recursive: true, force: true });
try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

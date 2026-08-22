// Verify (2.4 — goal bar): setGoal holds a tab to a standing goal. After a
// file-touching turn, runGoalReview judges `git diff HEAD` against the GOAL (never
// the conversation) using the SAME read-only verifier subagent (no tools, isolated
// context). PASS returns a verdict + leaves rounds; FAIL burns a round and returns
// a `steer` to feed back as the next turn; rounds count down to a hard stop.
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

// a git repo with one committed file.
const repo = await fs.mkdtemp(path.join(os.tmpdir(), "dom-gb-"));
await fs.writeFile(path.join(repo, "a.txt"), "AAA\n");
const git = (args) => execSync(`git ${args}`, { cwd: repo, stdio: "pipe" });
git("init -q"); git("config user.email x@y.z"); git("config user.name x"); git("add -A"); git("commit -qm init");

let reviewReq = null;
let verdictText = "PASS the change satisfies the goal.";
let gi = 0;
const genSteps = [
  toolSSE("read", { path: "a.txt" }),
  toolSSE("edit", { path: "a.txt", old_str: "AAA", new_str: "AAA2" }),
  textSSE("done"),
];
globalThis.fetch = async (_u, init) => {
  const body = JSON.parse(init.body);
  const sys = String(body.messages[0].content);
  if (/skeptical code reviewer/.test(sys)) {
    reviewReq = { system: sys, tools: body.tools, user: String(body.messages.find((m) => m.role === "user").content) };
    return sse(textSSE(verdictText, { p: 20, c: 5, cost: 0.01 }));
  }
  return sse(genSteps[Math.min(gi++, genSteps.length - 1)]);
};

const model = { id: "m", name: "M", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"], input_modalities: ["text"] };
const mkEngine = () => new Engine({ apiKey: "test", cwd: repo, systemPrompt: "GENERATOR_SECRET_PROMPT — do the work", models: [model], session: createSession(repo, "m", "yolo"), skills: [], autoCommit: false });
const noopCb = { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult() {}, onSystem() {}, async requestPermission() { return "yes"; } };

// --- setGoal / no-review guards ---------------------------------------------
{
  const e = mkEngine();
  ok("runGoalReview returns null with no goal", (await e.runGoalReview()) === null);
  const g = e.setGoal({ text: "make it AAA2", maxRounds: 2 });
  ok("setGoal seeds rounds from maxRounds", g.roundsLeft === 2 && g.maxRounds === 2 && g.active === true);
  ok("runGoalReview returns null before any file is touched", (await e.runGoalReview()) === null);
}

// --- PASS: reviews goal + git diff HEAD, no tools, isolated, rounds intact ---
{
  gi = 0; verdictText = "PASS the change satisfies the goal."; reviewReq = null;
  await fs.writeFile(path.join(repo, "a.txt"), "AAA\n"); // reset to HEAD
  const e = mkEngine();
  e.setGoal({ text: "change AAA to AAA2 in a.txt", maxRounds: 3 });
  await e.run("edit a.txt", noopCb);
  const r = await e.runGoalReview();
  ok("PASS verdict returned", r && r.verdict === "pass");
  ok("PASS leaves the round counter untouched", r && r.roundsLeft === 3 && !r.steer);
  ok("reviewer used the skeptical-reviewer prompt (same subagent)", reviewReq && /skeptical code reviewer/.test(reviewReq.system));
  ok("reviewer saw NO tools", reviewReq && (!reviewReq.tools || reviewReq.tools.length === 0));
  ok("reviewer judged the GOAL, not the request", reviewReq && reviewReq.user.includes("change AAA to AAA2 in a.txt") && /GOAL/.test(reviewReq.user));
  ok("reviewer saw the git-diff-HEAD change (AAA2)", reviewReq && /AAA2/.test(reviewReq.user) && /a\.txt/.test(reviewReq.user));
  ok("reviewer did NOT see the generator's prompt or conversation", reviewReq && !reviewReq.user.includes("GENERATOR_SECRET_PROMPT") && !reviewReq.user.includes("edit a.txt"));
}

// --- FAIL: burns a round and returns a steer with the feedback ---------------
{
  gi = 0; verdictText = "FAIL the change is incomplete and wrong."; reviewReq = null;
  await fs.writeFile(path.join(repo, "a.txt"), "AAA\n");
  const e = mkEngine();
  e.setGoal({ text: "the goal text", maxRounds: 2 });
  await e.run("edit a.txt", noopCb);
  const r1 = await e.runGoalReview();
  ok("FAIL returns a fail verdict", r1 && r1.verdict === "fail");
  ok("FAIL burns a round (2 → 1)", r1 && r1.roundsLeft === 1);
  ok("FAIL returns a steer carrying the reviewer feedback + goal", r1 && r1.steer && /incomplete and wrong/.test(r1.steer) && r1.steer.includes("the goal text"));
  // second fail exhausts the last round…
  const r2 = await e.runGoalReview();
  ok("second FAIL burns the last round (1 → 0)", r2 && r2.roundsLeft === 0 && r2.steer);
  // …after which reviews stop (hard round cap).
  const r3 = await e.runGoalReview();
  ok("no more reviews once rounds hit 0", r3 === null);
}

// --- paused goal is not reviewed --------------------------------------------
{
  gi = 0; verdictText = "FAIL nope.";
  await fs.writeFile(path.join(repo, "a.txt"), "AAA\n");
  const e = mkEngine();
  e.setGoal({ text: "g", maxRounds: 3, active: false });
  await e.run("edit a.txt", noopCb);
  ok("a paused goal (active:false) is not reviewed", (await e.runGoalReview()) === null);
}

await fs.rm(repo, { recursive: true, force: true });
try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

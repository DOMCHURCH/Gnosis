// Verify (automatic session memory): recordSession rolls the derived banks forward
// (files every session, errors always, decisions at 2+ files, patterns at 3+
// sightings); buildLearnedContext produces the LEARNED CONTEXT block; it is injected
// into the system prompt; /memory-style stats + panel summaries are accurate; clear
// wipes everything; and a file-touching engine turn auto-extracts a fact.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const sm = await import("../dist/sessionmemory.js");
const { buildSystemPrompt } = await import("../dist/system-prompt.js");
const { Engine } = await import("../dist/engine.js");
const { createSession } = await import("../dist/config.js");

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const fact = (over) => ({ sessionId: "s", timestamp: new Date().toISOString(), files_touched: ["src/a.ts"], ...over });

// --- banks: files/errors/decisions/patterns thresholds --------------------------
{
  await sm.recordSession(fact({ sessionId: "s1", files_touched: ["src/a.ts", "src/b.ts"], decision: "use a coordinator", pattern: "zod schema for tool args", error_recovery: "fixed ENOENT by mkdir -p" }));
  await sm.recordSession(fact({ sessionId: "s2", files_touched: ["src/a.ts"], pattern: "zod schema for tool args" }));

  let learned = await sm.buildLearnedContext();
  ok("a decision affecting 2+ files is logged", learned.includes("use a coordinator"));
  ok("a pattern is NOT promoted before 3 sightings", !learned.includes("zod schema for tool args"));

  await sm.recordSession(fact({ sessionId: "s3", files_touched: ["src/a.ts"], pattern: "zod schema for tool args" }));
  learned = await sm.buildLearnedContext();
  ok("a pattern IS promoted once it recurs 3+ times", learned.includes("zod schema for tool args"));
  ok("the learned block is labelled with the session count", /--- Learned context \(from 3 sessions\) ---/.test(learned));
}

// --- stats + panel summary ------------------------------------------------------
{
  const stats = await sm.learnedStats();
  ok("stats report 3 sessions", stats.sessions === 3);
  ok("stats report tracked files and an oldest timestamp", stats.files >= 2 && !!stats.oldest);

  const panel = await sm.panelSummary();
  ok("panel: src/a.ts is the most-touched file (×3)", panel.topFiles[0]?.path === "src/a.ts" && panel.topFiles[0]?.count === 3);
  ok("panel: at most 5 top files", panel.topFiles.length <= 5);
  ok("panel: recent decisions surfaced", panel.decisions.includes("use a coordinator"));
  ok("panel: session count matches", panel.sessions === 3);
}

// --- system-prompt injection ----------------------------------------------------
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dom-sp-"));
  const prompt = await buildSystemPrompt(dir, [], 0);
  ok("the system prompt carries the LEARNED CONTEXT section", /Learned context \(from 3 sessions\)/.test(prompt));
  ok("the injected context includes a promoted pattern", prompt.includes("zod schema for tool args"));
  await fs.rm(dir, { recursive: true, force: true });
}

// --- clear wipes everything -----------------------------------------------------
{
  await sm.clearSessionMemory();
  ok("after clear, learned context is empty", (await sm.buildLearnedContext()) === "");
  ok("after clear, stats show 0 sessions", (await sm.learnedStats()).sessions === 0);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dom-sp2-"));
  const prompt = await buildSystemPrompt(dir, [], 0);
  ok("after clear, the next boot's system prompt has no learned context", !/Learned context/.test(prompt));
  await fs.rm(dir, { recursive: true, force: true });
}

// --- engine level: a file-touching turn auto-extracts a fact --------------------
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dom-eng-"));
  const f = path.join(dir, "code.ts");
  await fs.writeFile(f, "export const x = 1;\n");
  const model = { id: "anthropic/claude-sonnet-4.6", name: "S", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"] };
  const sse = (b) => new Response(b, { status: 200, headers: { "content-type": "text/event-stream" } });
  const usage = `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":50,"completion_tokens":10,"cost":0.001}}\n\ndata: [DONE]\n\n`;
  const textSSE = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n${usage}`;
  const toolSSE = (name, a) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name, arguments: JSON.stringify(a) } }] } }] })}\n\n${usage}`;

  let sawSummarizer = false;
  let calls = 0;
  globalThis.fetch = async (_u, init) => {
    const sys = String(JSON.parse(init.body).messages?.[0]?.content ?? "");
    if (/distill one coding-session turn/i.test(sys)) {
      sawSummarizer = true;
      return sse(textSSE('{"decision":"","pattern":"append-only edits","error_recovery":""}'));
    }
    calls++;
    if (calls === 1) return sse(toolSSE("read", { path: f }));
    if (calls === 2) return sse(toolSSE("edit", { path: f, old_str: "export const x = 1;", new_str: "export const x = 2;" }));
    return sse(textSSE("done"));
  };

  const engine = new Engine({ apiKey: "test", cwd: dir, systemPrompt: "SYS", models: [model], session: createSession(dir, model.id, "yolo"), skills: [], autoCommit: false });
  await engine.run("bump the constant", { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult() {}, onSystem() {}, requestPermission: async () => "yes" });

  ok("the summarizer ran on a file-touching turn", sawSummarizer);
  const facts = await sm.allFacts();
  ok("a session fact was recorded for the edited file", facts.length === 1 && facts[0].files_touched.includes("code.ts"));
  ok("the distilled pattern was captured on the fact", facts[0].pattern === "append-only edits");
  await fs.rm(dir, { recursive: true, force: true });
  await sm.clearSessionMemory();
}

await fs.rm(fake, { recursive: true, force: true });
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

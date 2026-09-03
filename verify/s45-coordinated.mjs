// Verify (coordinated parallel sub-agents): task({coordinate,subtasks}) spawns one
// read-only sub-agent per subtask in PARALLEL; each emits its own subagent.start/end
// on the bus (so the office floor shows N figures at once, vanishing individually);
// only the coordinator's synthesized result enters parent history (never sub-agent
// tool calls); cost is attributed per sub-agent; a sub-agent cannot itself coordinate.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { Engine } = await import("../dist/engine.js");
const { createSession } = await import("../dist/config.js");
const { EventBus } = await import("../dist/events.js");

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const sse = (b) => new Response(b, { status: 200, headers: { "content-type": "text/event-stream" } });
const usage = `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":50,"completion_tokens":10,"cost":0.001}}\n\ndata: [DONE]\n\n`;
const textSSE = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n${usage}`;
const toolSSE = (name, args) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n${usage}`;

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dom-coord-"));
const prevCwd = process.cwd();
process.chdir(dir);
await fs.mkdir(path.join(dir, "src"));
await fs.writeFile(path.join(dir, "src", "permissions.ts"), "export function gate() {}\n");
const model = { id: "anthropic/claude-sonnet-4.6", name: "S", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"] };
const mkEngine = (mode = "ask") => new Engine({ apiKey: "test", cwd: dir, systemPrompt: "SYS", models: [model], session: createSession(dir, model.id, mode), skills: [], autoCommit: false });

async function turn(engine) {
  const results = [];
  await engine.run("go", { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult(c, r) { results.push({ name: c.name, r }); }, onSystem() {}, async requestPermission() { return "no"; } });
  return results;
}

const SUBTASKS = [
  { description: "auth and permissions", prompt: "check permissions" },
  { description: "exposed secrets", prompt: "check secrets" },
  { description: "sql injection and xss", prompt: "check injection" },
  { description: "unsafe bash and traversal", prompt: "check bash" },
];

// Mock: sub-agent turns (by system prompt) each grep once, then summarize with a
// tag naming their own description; parent issues ONE coordinated task, then done.
// Track concurrency: how many sub-agents are in-flight simultaneously.
let inFlight = 0, maxInFlight = 0;
globalThis.fetch = async (_u, init) => {
  const msgs = JSON.parse(init.body).messages;
  const sys = String(msgs?.[0]?.content ?? "");
  const userText = String(msgs?.find((m) => m.role === "user")?.content ?? "");
  if (/research sub-agent/i.test(sys)) {
    // First call for this sub-agent: it has no prior tool result → grep. Else summarize.
    const hasToolResult = msgs.some((m) => m.role === "tool");
    if (!hasToolResult) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Hold briefly so the four sub-agents genuinely overlap in time.
      await new Promise((r) => setTimeout(r, 30));
      return sse(toolSSE("grep", { pattern: "x" }));
    }
    inFlight--;
    return sse(textSSE(`FINDING[${userText}]: clean`));
  }
  // parent
  if (!msgs.some((m) => m.role === "tool")) {
    return sse(toolSSE("task", { description: "security audit", coordinate: true, subtasks: SUBTASKS }));
  }
  return sse(textSSE("synthesis: no issues found"));
};

// --- (1,2,3,4) coordinated task: parallelism, floor events, history, cost --------
{
  const bus = new EventBus();
  const starts = [], ends = [];
  bus.subscribe((e) => { if (e.type === "subagent.start") starts.push(e.description); if (e.type === "subagent.end") ends.push(e.description); });
  const engine = mkEngine("ask");
  engine.bus = bus;
  const results = await turn(engine);

  const t = results.find((x) => x.name === "task");
  ok("the coordinated task returns a combined result", t && !t.r.isError);
  ok("all four sub-agent summaries are present in the result", t && SUBTASKS.every((s) => t.r.output.includes(s.prompt)));
  ok("the result header reports four sub-agents", t && /4 sub-agents/.test(t.r.output));

  ok("four subagent.start events fired (four figures on the floor)", starts.length === 4);
  ok("all four ran in parallel (overlapped in flight)", maxInFlight === 4);
  ok("four subagent.end events fired (figures vanish as each completes)", ends.length === 4);

  const toolMsgs = engine.messages.filter((m) => m.role === "tool");
  ok("parent history has the coordinator's task result", toolMsgs.some((m) => m.name === "task"));
  ok("parent history does NOT contain any sub-agent tool calls (grep)", !toolMsgs.some((m) => m.name === "grep"));
  ok("parent transcript only ever sees the task call", results.every((x) => x.name === "task"));

  ok("cost is attributed per sub-agent (four entries)", (engine.cost.subAgents ?? []).length === 4);
  ok("each sub-agent cost entry is labelled with its description", (engine.cost.subAgents ?? []).map((r) => r.label).sort().join("|") === SUBTASKS.map((s) => s.description).sort().join("|"));
  ok("sub-agent spend folds into the session total and is tracked separately", (engine.cost.subAgentUsd ?? 0) > 0 && engine.cost.usd >= (engine.cost.subAgentUsd ?? 0));
}

// --- (5) a sub-agent cannot itself launch a coordinated task --------------------
{
  const sub = mkEngine("yolo");
  sub.isSubAgent = true;
  sub.toolAllowList = ["read", "glob", "grep", "http", "task"]; // force-expose task
  let served = false;
  globalThis.fetch = async () => { if (!served) { served = true; return sse(toolSSE("task", { description: "x", coordinate: true, subtasks: SUBTASKS })); } return sse(textSSE("done")); };
  const results = await turn(sub);
  const t = results.find((x) => x.name === "task");
  ok("a sub-agent attempting a coordinated task is refused", t && t.r.isError && /only be launched by the top-level agent/i.test(t.r.output));
}

// --- (6) budget reservation: a burst near the ceiling doesn't let all through ---
// Parallel sub-agents each used to check the dollar ceiling independently at
// spawn time, all in the same tick — none saw a sibling's cost yet, so a
// burst near the ceiling could let every one of them through. This proves the
// fix reserves synchronously BEFORE each dispatch: exactly the subtasks that
// fit are dispatched, the rest are refused without ever running, and genuine
// concurrency among the ones that DO proceed is untouched.
{
  // Non-zero pricing, unlike the zero-cost `model` used above — the
  // reservation estimate comes from pricing.prompt/completion, so a
  // free/zero-priced model would estimate every subtask at $0 and never
  // refuse anything.
  const pricedModel = { ...model, pricing: { prompt: 0.000001, completion: 0.000002, cacheRead: 0, cacheWrite: 0 } };
  const engine = new Engine({ apiKey: "test", cwd: dir, systemPrompt: "SYS", models: [pricedModel], session: createSession(dir, pricedModel.id, "yolo"), skills: [], autoCommit: false });
  engine.budgetCeiling = 0.05; // three subtasks estimated at $0.02 each: two fit, the third doesn't

  const TOKEN_BUDGET = 10_000; // * $0.000002/token (the higher of prompt/completion) = $0.02 estimate each
  const threeSubtasks = [
    { description: "sub A", prompt: "do A", tokenBudget: TOKEN_BUDGET },
    { description: "sub B", prompt: "do B", tokenBudget: TOKEN_BUDGET },
    { description: "sub C", prompt: "do C", tokenBudget: TOKEN_BUDGET },
  ];

  // A controllable stub standing in for a real sub-agent turn: resolves after
  // a delay (so dispatched sub-agents genuinely overlap in time, same as the
  // fetch-mock's 30ms hold above) and, on resolving, folds a real cost into
  // engine.cost.usd — exactly what applyUsage() does for a real completion —
  // so the NEXT subtask's reservation check sees true committed spend, not a
  // stale estimate.
  let inFlight2 = 0, maxInFlight2 = 0;
  const dispatched = [];
  engine.runSubAgent = async (description) => {
    dispatched.push(description);
    inFlight2++;
    maxInFlight2 = Math.max(maxInFlight2, inFlight2);
    await new Promise((r) => setTimeout(r, 30));
    engine.cost.usd += 0.02;
    inFlight2--;
    return { text: `done: ${description}`, tools: 0, tokens: 0, capped: null };
  };

  const endedRefused = [];
  engine.bus = { emit: (e) => { if (e.type === "subagent.end" && e.ok === false) endedRefused.push(e.description); } };

  const results = await engine.runCoordinatedTask(threeSubtasks, undefined, {});

  ok("all three subtasks return a result (none throw)", results.length === 3);
  const refused = results.filter((r) => r.capped === "budget");
  const proceeded = results.filter((r) => r.capped !== "budget");
  ok("exactly one of the three near-ceiling subtasks is refused, not all three going through", refused.length === 1);
  ok("...and the other two actually proceeded", proceeded.length === 2);
  ok("the refused one was never actually dispatched to runSubAgent", !dispatched.includes(refused[0]?.description));
  ok("the refused one's text explains the budget ceiling", /budget ceiling/i.test(refused[0]?.text ?? ""));
  ok("the two that proceeded genuinely overlapped (concurrency preserved by the fix)", maxInFlight2 === 2);
  ok("a subagent.end(ok:false) fired for the refused one so its floor row doesn't hang at 'queued' forever",
    endedRefused.includes(refused[0]?.description));
  ok("final committed cost reflects exactly the two that actually ran ($0.04), not a phantom third",
    Math.abs(engine.cost.usd - 0.04) < 1e-9);
}

process.chdir(prevCwd);
await fs.rm(dir, { recursive: true, force: true });
await fs.rm(fake, { recursive: true, force: true });
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

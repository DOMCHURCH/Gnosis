// Verify (sub-agent tool grants): the grant filter allows web_search / http / MCP
// playwright+context7 and hard-blocks write/edit/bash/etc.; at the engine level a
// task({tools:["web_search"]}) lets the sub-agent call web_search, while bash is an
// unknown tool regardless of the tools array, and no tools[] keeps the read-only default.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake; process.env.HOME = fake;

const { grantableSubagentTools, Engine } = await import("../dist/engine.js");
const { createSession } = await import("../dist/config.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- grant filter ----------------------------------------------------------------
ok("web_search + http are grantable", JSON.stringify(grantableSubagentTools(["web_search", "http"])) === JSON.stringify(["web_search", "http"]));
ok("playwright + context7 MCP tools are grantable", JSON.stringify(grantableSubagentTools(["mcp__playwright__browser_navigate", "mcp__context7__resolve"])) === JSON.stringify(["mcp__playwright__browser_navigate", "mcp__context7__resolve"]));
ok("write/edit/bash/send_message/list_tabs/task are hard-blocked", grantableSubagentTools(["write", "edit", "bash", "send_message", "list_tabs", "task"]).length === 0);
ok("an unrelated MCP tool is not grantable", grantableSubagentTools(["mcp__evil__rm"]).length === 0);
ok("undefined tools → no grants (read-only default)", grantableSubagentTools(undefined).length === 0);
ok("bash is stripped even when mixed with an allowed tool", JSON.stringify(grantableSubagentTools(["bash", "web_search"])) === JSON.stringify(["web_search"]));

// --- engine integration ----------------------------------------------------------
const model = { id: "m", name: "M", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"], input_modalities: ["text"] };
const sse = (b) => new Response(b, { status: 200, headers: { "content-type": "text/event-stream" } });
const u = `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n`;
const textSSE = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n${u}`;
const toolSSE = (name, args) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n${u}`;

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dom-sat-"));
const mkEngine = () => new Engine({ apiKey: "test", cwd: dir, systemPrompt: "SYS", models: [model], session: createSession(dir, "m", "ask"), skills: [], autoCommit: false });
async function turn(engine) {
  const results = [];
  await engine.run("go", { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult(c, r) { results.push({ name: c.name, r }); }, onSystem() {}, async requestPermission() { return "no"; } });
  return results;
}

// (1) tools:["web_search"] — the sub-agent may call web_search (not "unknown tool").
{
  let subToolError = null;
  globalThis.fetch = async (_u, init) => {
    const msgs = JSON.parse(init.body).messages;
    const sys = String(msgs?.[0]?.content ?? "");
    if (/research sub-agent/i.test(sys)) {
      const hasTool = msgs.some((m) => m.role === "tool");
      if (!hasTool) return sse(toolSSE("web_search", { query: "x" }));
      // capture how the web_search tool result came back to the sub-agent
      subToolError = String([...msgs].reverse().find((m) => m.role === "tool")?.content ?? "");
      return sse(textSSE("searched ok"));
    }
    return msgs.some((m) => m.role === "tool") ? sse(textSSE("done")) : sse(toolSSE("task", { description: "web", prompt: "find", tools: ["web_search"] }));
  };
  await turn(mkEngine());
  ok("a granted sub-agent's web_search is NOT an unknown tool", subToolError !== null && !/unknown tool: web_search/i.test(subToolError));
}

// (2) bash is unknown in a sub-agent regardless of the tools array.
{
  let subBash = null;
  globalThis.fetch = async (_u, init) => {
    const msgs = JSON.parse(init.body).messages;
    if (/research sub-agent/i.test(String(msgs?.[0]?.content ?? ""))) {
      const hasTool = msgs.some((m) => m.role === "tool");
      if (!hasTool) return sse(toolSSE("bash", { command: "ls" }));
      subBash = String([...msgs].reverse().find((m) => m.role === "tool")?.content ?? "");
      return sse(textSSE("done"));
    }
    return msgs.some((m) => m.role === "tool") ? sse(textSSE("done")) : sse(toolSSE("task", { description: "x", prompt: "y", tools: ["bash", "web_search"] }));
  };
  await turn(mkEngine());
  ok("bash in a sub-agent is an unknown tool even with tools:[...]", subBash !== null && /unknown tool: bash/i.test(subBash));
}

// (3) no tools[] → web_search is unknown (read-only default preserved).
{
  let subWs = null;
  globalThis.fetch = async (_u, init) => {
    const msgs = JSON.parse(init.body).messages;
    if (/research sub-agent/i.test(String(msgs?.[0]?.content ?? ""))) {
      const hasTool = msgs.some((m) => m.role === "tool");
      if (!hasTool) return sse(toolSSE("web_search", { query: "x" }));
      subWs = String([...msgs].reverse().find((m) => m.role === "tool")?.content ?? "");
      return sse(textSSE("done"));
    }
    return msgs.some((m) => m.role === "tool") ? sse(textSSE("done")) : sse(toolSSE("task", { description: "x", prompt: "y" }));
  };
  await turn(mkEngine());
  ok("without tools[], web_search stays unknown in a sub-agent", subWs !== null && /unknown tool: web_search/i.test(subWs));
}

await fs.rm(dir, { recursive: true, force: true });
await fs.rm(fake, { recursive: true, force: true });
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

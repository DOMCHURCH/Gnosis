// Verify (3.4 — headless JSON mode): `dom --json` streams structured JSONL events
// to stdout — a session line first, tool_use/tool_result for each call, a terminal
// result line last; every line is valid JSON. Secrets are redacted in tool inputs
// shown to the consumer, while the real value is still written to disk (execution
// uses real bytes; redaction is display-only).
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

process.stdin.isTTY = true; // so readStdin() returns "" instead of blocking on stdin

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { Engine } = await import("../dist/engine.js");
const { createSession } = await import("../dist/config.js");
const { runJson } = await import("../dist/jsonrun.js");

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const sse = (b) => new Response(b, { status: 200, headers: { "content-type": "text/event-stream" } });
const usage = (c) => `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":1,"cost":${c}}}\n\ndata: [DONE]\n\n`;
const textSSE = (t, c) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n${usage(c)}`;
const toolSSE = (name, args, c) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call1", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n${usage(c)}`;
const model = { id: "m", name: "M", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"], input_modalities: ["text"] };

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dom-json-"));
const SECRET = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// One turn: (1) write a new file whose content embeds a secret, then (2) a final answer.
let n = 0;
globalThis.fetch = async (url) => {
  if (String(url).includes("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
  return sse(n++ === 0
    ? toolSSE("write", { path: "note.txt", content: `token=${SECRET}` }, 0.01)
    : textSSE("Wrote the file.", 0.01));
};

// Capture stdout (the JSONL stream) while runJson runs; restore no matter what.
const realWrite = process.stdout.write.bind(process.stdout);
let buf = "";
let code;
try {
  process.stdout.write = (chunk) => { buf += chunk; return true; };
  const e = new Engine({ apiKey: "test", cwd: dir, systemPrompt: "t", models: [model], session: createSession(dir, "m", "yolo"), skills: [], autoCommit: false });
  code = await runJson(e, { prompt: "make a note", save: false });
} finally {
  process.stdout.write = realWrite;
}

const lines = buf.split("\n").filter(Boolean);
const events = [];
let allParse = true;
for (const l of lines) { try { events.push(JSON.parse(l)); } catch { allParse = false; } }

ok("every stdout line is valid JSON (JSONL)", allParse && events.length > 0);
ok("first event is session with sessionId/model/cwd",
  events[0]?.type === "session" && !!events[0].sessionId && events[0].model === "m" && events[0].cwd === dir);
ok("last event is the terminal result", events[events.length - 1]?.type === "result");

const toolUse = events.find((x) => x.type === "tool_use");
ok("a tool_use event carries id/name/structured input",
  toolUse && toolUse.id === "call1" && toolUse.name === "write" && toolUse.input && toolUse.input.path === "note.txt");
const inputStr = JSON.stringify(toolUse?.input ?? {});
ok("the secret in tool input is redacted for the consumer", /<redacted:api-key>/.test(inputStr) && !inputStr.includes(SECRET));

const toolResult = events.find((x) => x.type === "tool_result");
ok("a tool_result event reports name + ok", toolResult && toolResult.name === "write" && toolResult.ok === true);

const result = events[events.length - 1];
ok("result.ok true with the final answer text", result.ok === true && /Wrote the file\./.test(result.text));
ok("runJson returns exit code 0 on success", code === 0);

// Execution used the REAL bytes — the secret is on disk, unredacted.
const written = await fs.readFile(path.join(dir, "note.txt"), "utf8");
ok("the file on disk contains the real (unredacted) secret", written.includes(SECRET));

await fs.rm(dir, { recursive: true, force: true });
try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

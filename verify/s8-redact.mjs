// Verify (2.5 — secret redaction): redactSecrets masks known credential shapes;
// tool RESULTS and the model's tool-call ARGS are redacted in history/transcript,
// but the REAL command still executes (redaction never breaks execution).
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { redactSecrets } = await import("../dist/redact.js");
const { callParts } = await import("../dist/ui/toolrender.js");
const { Engine } = await import("../dist/engine.js");
const { createSession } = await import("../dist/config.js");

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

// --- module: patterns --------------------------------------------------------
const SK = "sk-test1234567890abcdefghij1234";
ok("openai/openrouter-style key", redactSecrets(`key=${SK}`).text === "key=<redacted:api-key>");
ok("AWS access key", redactSecrets("AKIAIOSFODNN7EXAMPLE here").text.includes("<redacted:aws-access-key>"));
ok("github token", redactSecrets("ghp_" + "a".repeat(36)).text === "<redacted:github-token>");
ok("bearer token keeps the prefix", /Bearer <redacted:bearer-token>/.test(redactSecrets("Authorization: Bearer abcdef0123456789ABCDEF").text));
ok("private key block", redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----").text === "<redacted:private-key>");
ok("google api key", redactSecrets("AIza" + "b".repeat(35)).text === "<redacted:google-key>");
ok("counts multiple secrets", redactSecrets(`${SK} and AKIAIOSFODNN7EXAMPLE`).count === 2);
ok("ordinary text is untouched (no false positives)", redactSecrets("just some normal output, path src/engine.ts, 42 lines").count === 0);

// --- transcript display is redacted -----------------------------------------
{
  const p = callParts("bash", { command: `curl -H "Authorization: Bearer abcdef0123456789ABCDEF" https://api.example.com` });
  ok("callParts redacts a command's secret for display", p.primary.includes("<redacted:bearer-token>") && !p.primary.includes("abcdef0123456789ABCDEF"));
}

// --- engine: results + args redacted, execution uses the REAL command -------
const sse = (b) => new Response(b, { status: 200, headers: { "content-type": "text/event-stream" } });
const u = `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n`;
const textSSE = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n${u}`;
const toolSSE = (name, args) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n${u}`;
const model = { id: "m", name: "M", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"], input_modalities: ["text"] };

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dom-red-"));
await fs.writeFile(path.join(dir, "secret.txt"), `OPENAI_KEY=${SK}\n`);
const runTurn = async (script) => {
  let i = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    return sse(script[Math.min(i++, script.length - 1)]);
  };
  const e = new Engine({ apiKey: "test", cwd: dir, systemPrompt: "t", models: [model], session: createSession(dir, "m", "yolo"), skills: [], autoCommit: false });
  const shown = [];
  await e.run("go", { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult(_c, r) { shown.push(r.output); }, onSystem() {}, async requestPermission() { return "yes"; } });
  return e;
};

// (a) result redaction: `cat secret.txt` output has the key → redacted in history.
{
  const e = await runTurn([toolSSE("bash", { command: "cat secret.txt" }), textSSE("done")]);
  const toolMsg = e.messages.find((m) => m.role === "tool");
  ok("a secret in tool OUTPUT is redacted in history", toolMsg && toolMsg.result.includes("<redacted:api-key>") && !toolMsg.result.includes(SK));
  ok("...the file on disk is untouched (execution unaffected)", (await fs.readFile(path.join(dir, "secret.txt"), "utf8")).includes(SK));
}

// (b) command-arg redaction: secret is in the COMMAND; grep for the REAL key must
//     succeed (proving execution used the real command), yet stored args are masked.
{
  const cmd = `grep -q ${SK} secret.txt && echo hit > found.txt`;
  const e = await runTurn([toolSSE("bash", { command: cmd }), textSSE("done")]);
  ok("the REAL command executed (grep found the real key)", existsSync(path.join(dir, "found.txt")));
  const assistant = e.messages.find((m) => m.role === "assistant" && m.calls);
  ok("the stored command args are redacted (model/session copy)", assistant && assistant.calls[0].args.includes("<redacted:api-key>") && !assistant.calls[0].args.includes(SK));
}

await fs.rm(dir, { recursive: true, force: true });
try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

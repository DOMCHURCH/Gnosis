// Verify (feature 1 — auto-commit): a successful write auto-commits exactly that
// one file with a "dom: " message; /undo reverts the last dom commit; a write
// outside a git repo succeeds and simply doesn't commit. Isolated to temp dirs.
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { Engine } = await import("../dist/engine.js");
const { createSession } = await import("../dist/config.js");
const { autoCommitFile, undoLastDomCommit } = await import("../dist/autocommit.js");
const { runWrite } = await import("../dist/tools/write.js");

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// SSE the engine will see: request 1 → a write tool call; request 2 → plain text (ends the turn).
const writeArgs = JSON.stringify({ path: "hello.py", content: "print('hi')\n" });
const toolSSE =
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "write", arguments: writeArgs } }] } }] })}\n\n` +
  `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n`;
const doneSSE = `data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n`;
let calls = 0;
globalThis.fetch = async () => {
  calls++;
  const body = calls === 1 ? toolSSE : doneSSE;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
};

const model = { id: "anthropic/claude-sonnet-4.6", name: "Sonnet", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"] };
const cb = () => { const systems = []; return { systems, cb: { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult() {}, onSystem: (t) => systems.push(t), async requestPermission() { return "no"; } } }; };

// --- in a git repo: one edit → one commit touching one file --------------------
const repo = await fs.mkdtemp(path.join(os.tmpdir(), "dom-repo-"));
git(repo, "init", "-q");
git(repo, "config", "user.email", "t@t");
git(repo, "config", "user.name", "t");
git(repo, "config", "commit.gpgsign", "false");
await fs.writeFile(path.join(repo, "README.md"), "seed\n");
git(repo, "add", "README.md");
git(repo, "commit", "-q", "-m", "seed");
const baseCount = Number(git(repo, "rev-list", "--count", "HEAD"));

const prevCwd = process.cwd();
process.chdir(repo);
{
  const engine = new Engine({ apiKey: "test", cwd: repo, systemPrompt: "t", models: [model], session: createSession(repo, model.id, "ask"), skills: [], autoCommit: true });
  const c = cb();
  await engine.run("make hello.py", c.cb);

  ok("the write actually landed on disk", existsSync(path.join(repo, "hello.py")));
  ok("exactly one new commit was created", Number(git(repo, "rev-list", "--count", "HEAD")) === baseCount + 1);
  ok("the commit subject is 'dom: create hello.py'", git(repo, "log", "-1", "--format=%s") === "dom: create hello.py");
  const touched = git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n").filter(Boolean);
  ok("the commit touches exactly one file (never git add -A)", touched.length === 1 && touched[0] === "hello.py");
  ok("the working tree is clean after the commit", git(repo, "status", "--porcelain") === "");
}

// --- /undo reverts the last dom commit -----------------------------------------
{
  const undone = await undoLastDomCommit(repo);
  ok("/undo reports what it reverted", undone && undone.message === "dom: create hello.py");
  ok("/undo restores the tree (a created file is removed)", !existsSync(path.join(repo, "hello.py")));
  ok("the revert is itself a commit (history preserved)", Number(git(repo, "rev-list", "--count", "HEAD")) === baseCount + 2);
}

// --- a second edit auto-commits as an 'edit' -----------------------------------
{
  await fs.writeFile(path.join(repo, "README.md"), "seed\nmore\n");
  const c = await autoCommitFile(path.join(repo, "README.md"), "edit");
  ok("editing a tracked file commits as 'dom: edit <file>'", c && c.message === "dom: edit README.md");
}

process.chdir(prevCwd);

// --- outside a git repo: a write succeeds and simply doesn't commit -------------
{
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), "dom-bare-"));
  process.chdir(bare);
  const res = await runWrite({ path: "note.txt", content: "hello\n" });
  ok("a write outside a repo succeeds (no error)", !res.isError && existsSync(path.join(bare, "note.txt")));
  const c = await autoCommitFile(path.join(bare, "note.txt"), "write");
  ok("auto-commit is a silent no-op outside a repo (never git init)", c === null && !existsSync(path.join(bare, ".git")));
  process.chdir(prevCwd);
  await fs.rm(bare, { recursive: true, force: true });
}

await fs.rm(repo, { recursive: true, force: true });
await fs.rm(fake, { recursive: true, force: true });
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

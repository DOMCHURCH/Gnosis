// Verify: Gnosis can clean up its OWN worktrees. Worktrees live under
// ~/.dom/worktrees, which the ~/.dom permission guard used to block wholesale —
// so an agent could open a worktree but could neither edit the files it checked
// out there nor ever run `git worktree remove` on it again.
//
// This exercises the real thing end to end: a real git repo, a real worktree, the
// real gate() decision, and the real git commands — then confirms the guard still
// hard-rejects the three things it actually exists to protect (config.json holds
// the API key, .env the secrets, sessions/ the history).
import { promises as fs } from "node:fs";
import os from "node:os"; import path from "node:path"; import { execa } from "execa";
delete process.env.GIT_DIR; delete process.env.GIT_WORK_TREE;
const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake; process.env.HOME = fake;

const { createWorktree, listWorktrees } = await import("../dist/worktree.js");
const { gate } = await import("../dist/permissions.js");
const { TOOLS } = await import("../dist/tools/index.js");
let fails = 0; const ok = (n,c) => { console.log(`${c?"PASS":"FAIL"} ${n}`); if(!c) fails++; };
const git = (cwd,...a) => execa("git", a, { cwd, reject:false });
const exists = async p => { try { await fs.access(p); return true } catch { return false } };

const repo = await fs.mkdtemp(path.join(os.tmpdir(), "dom-repo-"));
for (const a of [["init","-q"],["config","user.email","t@t.t"],["config","user.name","t"],["config","commit.gpgsign","false"]]) await git(repo,...a);
await fs.writeFile(path.join(repo,"base.txt"),"base\n");
await git(repo,"add","-A"); await git(repo,"commit","-qm","init");

const c = await createWorktree(repo, "cleanup me");
ok("worktree created under ~/.dom/worktrees", c.ok && await exists(c.info.path));
const wt = c.info.path;

// 1. the agent edits a file it checked out in the worktree
const editDecision = gate(TOOLS.write, { path: path.join(wt,"note.txt"), content:"x" }, { mode:"yolo", approvals:new Set(), cwd: wt });
ok("gate allows writing a file inside the worktree", editDecision.kind === "allow");

// 2. the agent removes the worktree with a real bash command
const cmd = `git worktree remove --force "${wt.split(path.sep).join("/")}"`;
const d = gate(TOOLS.bash, { command: cmd }, { mode:"yolo", approvals:new Set(), cwd: repo });
ok("gate allows the removal command (not a hard reject)", d.kind !== "reject");
if (d.kind === "reject") console.log("   reason:", d.reason);
const r = await execa("git", ["worktree","remove","--force",wt], { cwd: repo, reject:false });
ok("git worktree remove exits 0", r.exitCode === 0);
ok("the worktree directory is gone from disk", !(await exists(wt)));

// 3. and its branch is deletable
const b = await execa("git", ["branch","-D","dom/cleanup-me"], { cwd: repo, reject:false });
const bd = gate(TOOLS.bash, { command: "git branch -D dom/cleanup-me" }, { mode:"yolo", approvals:new Set(), cwd: repo });
ok("gate allows git branch -D in the repo", bd.kind !== "reject");
ok("git branch -D exits 0", b.exitCode === 0);
ok("no dom worktrees remain", (await listWorktrees(repo)).length === 0);

// 4. the things the guard exists for are STILL blocked
const secret = gate(TOOLS.read, { path: path.join(fake,".dom","config.json") }, { mode:"yolo", approvals:new Set(), cwd: repo });
ok("config.json is still a hard reject", secret.kind === "reject");
const envd = gate(TOOLS.bash, { command: "cat ~/.dom/.env" }, { mode:"yolo", approvals:new Set(), cwd: repo });
ok(".env is still a hard reject", envd.kind === "reject");
const sess = gate(TOOLS.bash, { command: "ls ~/.dom/sessions" }, { mode:"yolo", approvals:new Set(), cwd: repo });
ok("sessions/ is still a hard reject", sess.kind === "reject");

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails?1:0);

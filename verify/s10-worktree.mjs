// Verify (3.1 — git worktree isolation): createWorktree makes a dom/<name> branch
// checked out in a separate dir under ~/.dom/worktrees; edits committed there do
// NOT appear in the main working tree until mergeWorktree brings them back;
// removeWorktree cleans up. Runs against a real temp git repo — no model needed.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";

delete process.env.GIT_DIR; // don't let a parent git env leak into the temp repos
delete process.env.GIT_WORK_TREE;

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { createWorktree, listWorktrees, mergeWorktree, removeWorktree, worktreesDir } = await import("../dist/worktree.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };
const git = (cwd, ...args) => execa("git", args, { cwd, reject: false });
const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };

// --- a real repo with one commit --------------------------------------------
const repo = await fs.mkdtemp(path.join(os.tmpdir(), "dom-repo-"));
await git(repo, "init", "-q");
await git(repo, "config", "user.email", "t@t.t");
await git(repo, "config", "user.name", "t");
await git(repo, "config", "commit.gpgsign", "false");
await fs.writeFile(path.join(repo, "base.txt"), "base\n");
await git(repo, "add", "-A");
await git(repo, "commit", "-qm", "init");

// --- create -----------------------------------------------------------------
const c = await createWorktree(repo, "Feature X");
ok("createWorktree ok, name+branch slugged to feature-x / dom/feature-x", c.ok && c.info.name === "feature-x" && c.info.branch === "dom/feature-x");
ok("the worktree directory exists on disk", c.ok && (await exists(c.info.path)));
ok("the worktree lives under ~/.dom/worktrees", c.ok && c.info.path.startsWith(worktreesDir()));
const wtPath = c.ok ? c.info.path : "";

// --- isolation: commit a file in the worktree; main tree unaffected ---------
await fs.writeFile(path.join(wtPath, "feature.txt"), "hello\n");
await git(wtPath, "add", "-A");
await git(wtPath, "commit", "-qm", "add feature");
ok("the new file exists inside the worktree", await exists(path.join(wtPath, "feature.txt")));
ok("the new file is NOT in the main working tree (isolated)", !(await exists(path.join(repo, "feature.txt"))));

// --- list -------------------------------------------------------------------
const list = await listWorktrees(repo);
ok("listWorktrees includes the dom worktree", list.some((w) => w.name === "feature-x" && w.branch === "dom/feature-x"));

// --- duplicate create refused ----------------------------------------------
const dup = await createWorktree(repo, "feature x");
ok("creating the same worktree again is refused", !dup.ok && /already exists/.test(dup.error));

// --- merge back -------------------------------------------------------------
const m = await mergeWorktree(repo, "feature-x");
ok("mergeWorktree ok", m.ok);
ok("after merge the file is on the main branch", await exists(path.join(repo, "feature.txt")));

// --- remove -----------------------------------------------------------------
const rm = await removeWorktree(repo, "feature-x", { deleteBranch: true });
ok("removeWorktree ok", rm.ok);
const list2 = await listWorktrees(repo);
ok("listWorktrees no longer includes it", !list2.some((w) => w.name === "feature-x"));
ok("the worktree directory is gone", !(await exists(wtPath)));

// --- non-repo dir fails cleanly --------------------------------------------
const notRepo = await fs.mkdtemp(path.join(os.tmpdir(), "dom-norepo-"));
const nr = await createWorktree(notRepo, "x");
ok("createWorktree outside a repo fails with a clear error", !nr.ok && /not a git repository/.test(nr.error));

// cleanup
for (const d of [repo, notRepo, fake]) { try { await fs.rm(d, { recursive: true, force: true }); } catch {} }
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

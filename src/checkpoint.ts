// Git auto-checkpointing: every dom write/edit is recorded to a dedicated ref so
// it can be reverted, WITHOUT touching the user's working branch, HEAD, index, or
// staged changes. We only use content-addressed plumbing (hash-object, mktree,
// commit-tree, update-ref) — never `git add`/`commit`, never the real index.
//
// Each checkpoint is a commit on refs/dom/checkpoints whose flat tree holds:
//   meta  — JSON { tool, rel, iso, existed }
//   blob  — the file's PRE-edit bytes (present only when existed=true)
// Commits are chained by parent (newest = ref tip). /undo restores the tip's
// pre-edit content (or deletes the file if it was newly created) and steps the
// ref back to the parent, so repeated /undo walks history.

import { execa } from "execa";
import { promises as fs } from "node:fs";
import path from "node:path";

const REF = "refs/dom/checkpoints";

const IDENTITY = {
  GIT_AUTHOR_NAME: "dom",
  GIT_AUTHOR_EMAIL: "dom@checkpoint",
  GIT_COMMITTER_NAME: "dom",
  GIT_COMMITTER_EMAIL: "dom@checkpoint",
};

export interface CheckpointInfo {
  tool: string;
  rel: string;
  iso: string;
}

interface Meta extends CheckpointInfo {
  existed: boolean;
}

interface GitResult {
  ok: boolean;
  out: string;
}

async function git(cwd: string, args: string[], input?: string, env?: Record<string, string>): Promise<GitResult> {
  try {
    const res = await execa("git", args, {
      cwd,
      input,
      env: env ? { ...process.env, ...env } : undefined,
      reject: false,
      windowsHide: true,
      stripFinalNewline: false, // preserve exact bytes for cat-file content reads
    });
    return { ok: res.exitCode === 0, out: res.stdout ?? "" };
  } catch {
    return { ok: false, out: "" };
  }
}

// --- repo detection (lazy, silent when git is absent or not a work tree) -----

let gitChecked = false;
let gitPresent = false;
const rootCache = new Map<string, string | null>();

async function repoRoot(dir: string): Promise<string | null> {
  if (!gitChecked) {
    gitChecked = true;
    gitPresent = (await git(dir, ["--version"])).ok;
  }
  if (!gitPresent) return null;
  const cached = rootCache.get(dir);
  if (cached !== undefined) return cached;
  const res = await git(dir, ["rev-parse", "--show-toplevel"]);
  const root = res.ok && res.out.trim() ? path.resolve(res.out.trim()) : null;
  rootCache.set(dir, root);
  return root;
}

async function refTip(root: string): Promise<string | null> {
  const r = await git(root, ["rev-parse", "--verify", "--quiet", REF]);
  return r.ok && r.out.trim() ? r.out.trim() : null;
}

async function hashObject(root: string, content: string): Promise<string | null> {
  const r = await git(root, ["hash-object", "-w", "--no-filters", "--stdin"], content);
  return r.ok && r.out.trim() ? r.out.trim() : null;
}

// --- public API --------------------------------------------------------------

/**
 * Record a checkpoint for a successful write/edit. `preContent` is the file's
 * content BEFORE the change, or null if the file did not exist (a fresh create).
 * Never throws and never disrupts the edit — silently no-ops outside a git repo.
 */
export async function recordCheckpoint(
  tool: "write" | "edit",
  absPath: string,
  preContent: string | null,
): Promise<void> {
  try {
    const root = await repoRoot(path.dirname(absPath));
    if (!root) return;
    // Canonicalize both sides (Windows 8.3 short names, symlinks, casing) so the
    // repo-relative path is computed correctly against git's canonical toplevel.
    const realAbs = await fs.realpath(absPath).catch(() => absPath);
    const realRoot = await fs.realpath(root).catch(() => root);
    const rel = path.relative(realRoot, realAbs).split(path.sep).join("/");
    if (!rel || rel.startsWith("..")) return; // outside the repo — skip

    const existed = preContent !== null;
    const iso = new Date().toISOString();
    const meta: Meta = { tool, rel, iso, existed };

    const metaSha = await hashObject(root, JSON.stringify(meta));
    if (!metaSha) return;

    // Build a flat tree { blob?, meta } with mktree — no index involved.
    const entries: string[] = [];
    if (existed) {
      const blobSha = await hashObject(root, preContent!);
      if (!blobSha) return;
      entries.push(`100644 blob ${blobSha}\tblob`);
    }
    entries.push(`100644 blob ${metaSha}\tmeta`); // "blob" < "meta": already sorted
    const treeRes = await git(root, ["mktree"], entries.join("\n") + "\n");
    const tree = treeRes.out.trim();
    if (!treeRes.ok || !tree) return;

    const parent = await refTip(root);
    const commitArgs = ["commit-tree", tree, "-m", `dom checkpoint: ${tool} ${rel} ${iso}`];
    if (parent) commitArgs.push("-p", parent);
    const commitRes = await git(root, commitArgs, undefined, { ...IDENTITY, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
    const commit = commitRes.out.trim();
    if (!commitRes.ok || !commit) return;

    await git(root, ["update-ref", REF, commit]);
  } catch {
    /* checkpointing must never break a tool call */
  }
}

/**
 * Revert the most recent dom checkpoint: restore its file to the pre-edit content
 * (or delete it if it was newly created), then step the ref back to the parent.
 * Returns the reverted relative path, or null when there is nothing to undo.
 */
export async function undoLast(): Promise<string | null> {
  try {
    const root = await repoRoot(process.cwd());
    if (!root) return null;
    const tip = await refTip(root);
    if (!tip) return null;

    const metaRes = await git(root, ["cat-file", "-p", `${tip}:meta`]);
    if (!metaRes.ok) return null;
    let meta: Meta;
    try {
      meta = JSON.parse(metaRes.out);
    } catch {
      return null;
    }

    const target = path.join(root, meta.rel);
    if (meta.existed) {
      const blobRes = await git(root, ["cat-file", "-p", `${tip}:blob`]);
      if (!blobRes.ok) return null;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, blobRes.out, "utf8");
    } else {
      await fs.rm(target, { force: true });
    }

    const parentRes = await git(root, ["rev-parse", "--verify", "--quiet", `${tip}^`]);
    const parent = parentRes.ok && parentRes.out.trim() ? parentRes.out.trim() : null;
    if (parent) await git(root, ["update-ref", REF, parent]);
    else await git(root, ["update-ref", "-d", REF]);

    return meta.rel;
  } catch {
    return null;
  }
}

/** List recent checkpoints (newest first). Empty when disabled or none exist. */
export async function listCheckpoints(limit = 20): Promise<CheckpointInfo[]> {
  try {
    const root = await repoRoot(process.cwd());
    if (!root) return [];
    if (!(await refTip(root))) return [];
    const shaRes = await git(root, ["rev-list", "--first-parent", "-n", String(limit), REF]);
    if (!shaRes.ok) return [];
    const shas = shaRes.out.split("\n").map((s) => s.trim()).filter(Boolean);
    const out: CheckpointInfo[] = [];
    for (const sha of shas) {
      const metaRes = await git(root, ["cat-file", "-p", `${sha}:meta`]);
      if (!metaRes.ok) continue;
      try {
        const m = JSON.parse(metaRes.out) as Meta;
        out.push({ tool: m.tool, rel: m.rel, iso: m.iso });
      } catch {
        /* skip malformed */
      }
    }
    return out;
  } catch {
    return [];
  }
}

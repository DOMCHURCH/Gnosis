// File-tree walk for the web File Browser panel. Reads a session's cwd and returns
// a nested dir/file tree, skipping the noise dirs (.git, node_modules, dist, .dom).
// Pure fs input → plain data out, so it's unit-testable offline. The server exposes
// it over token-gated /api/tree; the browser renders it. Reads only — no writes.

import { promises as fs } from "node:fs";
import path from "node:path";

/** Directories never shown in the browser (build output, VCS, deps, dom state). */
export const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", ".dom"]);

export interface TreeNode {
  name: string;
  /** POSIX-style path relative to the tree root (forward slashes, stable on Windows). */
  path: string;
  type: "dir" | "file";
  children?: TreeNode[];
}

export interface TreeResult {
  cwd: string;
  tree: TreeNode[];
  /** True if the walk hit the entry cap and stopped early (tree is partial). */
  truncated: boolean;
}

interface WalkOpts {
  /** Stop after this many entries so a giant tree can't hang the server. */
  maxEntries: number;
  /** Don't descend deeper than this many levels. */
  maxDepth: number;
}

const DEFAULTS: WalkOpts = { maxEntries: 4000, maxDepth: 12 };

/** Sort dirs before files, each group case-insensitively by name. */
function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** Build the dir/file tree rooted at `root`, excluding the noise dirs. */
export async function buildTree(root: string, opts: Partial<WalkOpts> = {}): Promise<TreeResult> {
  const o = { ...DEFAULTS, ...opts };
  const state = { count: 0, truncated: false };

  async function walk(abs: string, rel: string, depth: number): Promise<TreeNode[]> {
    if (depth > o.maxDepth || state.truncated) return [];
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return []; // unreadable dir (permissions, race) — skip quietly
    }
    const out: TreeNode[] = [];
    for (const e of entries) {
      if (state.count >= o.maxEntries) { state.truncated = true; break; }
      const name = e.name;
      // symlinks reported as neither file nor dir are treated as files; skip others.
      const isDir = e.isDirectory();
      if (isDir && EXCLUDED_DIRS.has(name)) continue;
      if (name.startsWith(".") && EXCLUDED_DIRS.has(name)) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      state.count++;
      if (isDir) {
        const children = await walk(path.join(abs, name), childRel, depth + 1);
        out.push({ name, path: childRel, type: "dir", children });
      } else if (e.isFile() || e.isSymbolicLink()) {
        out.push({ name, path: childRel, type: "file" });
      }
    }
    return sortNodes(out);
  }

  const tree = await walk(root, "", 0);
  return { cwd: root, tree, truncated: state.truncated };
}

/** Max bytes returned for a file preview; larger files are truncated with a note. */
export const MAX_PREVIEW_BYTES = 256 * 1024;

export interface FilePreview {
  path: string;
  content: string;
  truncated: boolean;
}

/**
 * Read a file for preview, but ONLY if it resolves inside `root` — the guard that
 * stops `../` traversal out of the session's cwd. `rel` is a client-supplied
 * relative path. Returns null if it escapes root or can't be read.
 */
export async function readFileInRoot(root: string, rel: string): Promise<FilePreview | null> {
  const rootResolved = path.resolve(root);
  const full = path.resolve(rootResolved, rel);
  // Must stay within root (allow root itself). Compare with a trailing separator so
  // a sibling dir sharing a prefix (…/foo-bar vs …/foo) can't sneak through.
  const withSep = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
  if (full !== rootResolved && !full.startsWith(withSep)) return null;
  try {
    const stat = await fs.stat(full);
    if (!stat.isFile()) return null;
    const buf = await fs.readFile(full);
    const truncated = buf.length > MAX_PREVIEW_BYTES;
    const slice = truncated ? buf.subarray(0, MAX_PREVIEW_BYTES) : buf;
    return { path: rel.replace(/\\/g, "/"), content: slice.toString("utf8"), truncated };
  } catch {
    return null;
  }
}

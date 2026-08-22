// Obsidian vault helpers shared by the server and the web bridge: resolve the
// vault root, list its .md notes as a tree, and save a new note from the browser
// ("save to vault"). Path resolution lives in config.ts (resolveVaultPath); this
// module adds the md-only tree + the guarded note write.

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadConfig, resolveVaultPath } from "./config.js";
import { buildTree, type TreeResult } from "./filetree.js";

export interface VaultTree extends TreeResult {
  /** True when a vault path is configured (config or ~/.dom/AGENTS.md) AND exists. */
  configured: boolean;
  /** The absolute vault root, or null when not configured/missing. */
  root: string | null;
}

const isMarkdown = (name: string) => name.toLowerCase().endsWith(".md");

/** Resolve the vault and build its .md-only tree. When no vault is configured or
 * the path is missing, returns configured:false with an empty tree (never throws). */
export async function buildVaultTree(): Promise<VaultTree> {
  const vault = await resolveVaultPath(await loadConfig());
  if (!vault || !existsSync(vault)) {
    return { configured: false, root: null, cwd: vault ?? "", tree: [], truncated: false };
  }
  const tree = await buildTree(vault, { includeFile: isMarkdown });
  return { configured: true, root: vault, ...tree };
}

/** The resolved vault root if it's configured AND exists, else null. */
export async function vaultRoot(): Promise<string | null> {
  const vault = await resolveVaultPath(await loadConfig());
  return vault && existsSync(vault) ? vault : null;
}

export interface SaveNoteResult {
  ok: boolean;
  /** Vault-relative path of the note that was written (forward slashes). */
  path?: string;
  error?: string;
}

/** Turn a user-supplied note title into a safe `.md` filename. Keeps spaces (titles
 * like "My Idea.md" are normal in Obsidian) but strips path separators, reserved/
 * illegal characters, and leading dots — so no directories, traversal, or hidden
 * files can be created. */
function safeNoteFilename(name: string): string {
  let base = name.trim().replace(/\.md$/i, "");
  base = base.replace(/[\\/]+/g, " ");     // path separators -> space
  base = base.replace(/[<>:"|?*]/g, "");   // Windows-illegal characters
  base = base.replace(/\s+/g, " ").trim(); // collapse whitespace
  base = base.replace(/^\.+/, "").trim();  // strip leading dots (../, hidden files)
  if (!base) base = "untitled";
  return base + ".md";
}

/** Compose the note body: a YAML frontmatter `tags:` block (when any) followed by
 * the content. Tags are normalized (trimmed, spaces->dashes, deduped, non-empty). */
function composeNote(content: string, tags: string[]): string {
  const clean = Array.from(
    new Set(tags.map((t) => t.trim().replace(/^#/, "").replace(/\s+/g, "-")).filter(Boolean)),
  );
  const body = content.replace(/\s+$/, "") + "\n";
  if (!clean.length) return body;
  const fm = ["---", "tags:", ...clean.map((t) => `  - ${t}`), "---", ""].join("\n");
  return fm + "\n" + body;
}

/** Save a new note into the vault. Refuses to overwrite an existing note (adds a
 * ` 2`, ` 3`... suffix). Returns the vault-relative path written, or an error. */
export async function saveVaultNote(filename: string, tags: string[], content: string): Promise<SaveNoteResult> {
  const root = await vaultRoot();
  if (!root) return { ok: false, error: "no Obsidian vault is configured" };

  const base = safeNoteFilename(filename);
  let target = path.join(root, base);
  // Guard: the resolved file must stay directly inside the vault root.
  const rootResolved = path.resolve(root);
  if (path.dirname(path.resolve(target)) !== rootResolved) {
    return { ok: false, error: "invalid note name" };
  }
  // Don't clobber an existing note — find a free "<name> N.md".
  const stem = base.replace(/\.md$/i, "");
  for (let n = 2; existsSync(target); n++) target = path.join(root, `${stem} ${n}.md`);

  try {
    await fs.writeFile(target, composeNote(content, tags), "utf8");
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return { ok: true, path: path.relative(root, target).split(path.sep).join("/") };
}

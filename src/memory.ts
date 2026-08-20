// Memory bank: durable, agent-written notes about a project that persist across
// sessions and are re-injected into the system prompt at the start of every
// session. Kept OUTSIDE the repo (under ~/.dom/memory) so it never pollutes the
// user's tree, and keyed by the project's absolute path so each project has its
// own bank. The model writes to it with the `memory` tool; `/memory` shows or
// clears it.

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { domDir } from "./config.js";

export function memoryDir(): string {
  return path.join(domDir(), "memory");
}

/** Stable, human-readable, collision-resistant filename for a project path. */
export function memoryKey(cwd: string): string {
  const abs = path.resolve(cwd);
  const hash = crypto.createHash("sha1").update(abs.toLowerCase()).digest("hex").slice(0, 8);
  const base = path.basename(abs).replace(/[^a-zA-Z0-9._-]+/g, "-") || "root";
  return `${base}-${hash}.md`;
}

export function memoryPath(cwd: string): string {
  return path.join(memoryDir(), memoryKey(cwd));
}

/** Current memory-bank text for `cwd` ("" if none). */
export async function readMemory(cwd: string): Promise<string> {
  try {
    return (await fs.readFile(memoryPath(cwd), "utf8")).trim();
  } catch {
    return "";
  }
}

/** Count the bullet entries in a memory-bank body. */
export function countEntries(content: string): number {
  return content.split("\n").filter((l) => l.trim().startsWith("- ")).length;
}

/** Overwrite the whole memory bank (trimmed, newline-terminated). */
export async function writeMemory(cwd: string, content: string): Promise<void> {
  await fs.mkdir(memoryDir(), { recursive: true });
  await fs.writeFile(memoryPath(cwd), content.trim() + "\n", "utf8");
}

/** Append a note as a bullet, collapsing internal newlines. Exact-duplicate
 * bullets are ignored. Returns the resulting entry count. */
export async function appendMemory(cwd: string, note: string): Promise<number> {
  const clean = note.trim();
  const existing = await readMemory(cwd);
  if (!clean) return countEntries(existing);
  const bullet = `- ${clean.replace(/\s*\n\s*/g, " ")}`;
  const lines = existing ? existing.split("\n") : [];
  if (!lines.includes(bullet)) lines.push(bullet);
  const body = lines.join("\n");
  await writeMemory(cwd, body);
  return countEntries(body);
}

/** Remove the memory bank entirely. */
export async function clearMemory(cwd: string): Promise<void> {
  try {
    await fs.rm(memoryPath(cwd));
  } catch {
    /* already gone */
  }
}

/** Wrap the memory for injection into the system prompt ("" when empty). */
export function formatMemoryForPrompt(content: string): string {
  if (!content.trim()) return "";
  return `--- Memory bank (durable notes you saved about this project; update it with the memory tool) ---\n${content.trim()}`;
}

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

/**
 * Prompt-injection guard for the memory bank.
 *
 * The bank is written BY the model, from content the model read — a file, a web
 * page, a tool result — and is replayed verbatim into the system prompt of every
 * later session. That makes it a persistence mechanism: text that talks the model
 * into a false identity only has to land here once to be re-asserted, with the
 * authority of the system prompt, in every session that follows.
 *
 * So notes are filtered on the way in AND on the way out. Filtering on read
 * matters most: a bank poisoned before this guard existed is disarmed the next
 * time it is loaded, without the user having to know to clear it.
 *
 * Deliberately narrow. These patterns match attempts to reassign who the
 * assistant IS or who it works for — not ordinary notes that happen to discuss
 * identity, auth, or organizations.
 */
const INJECTION_PATTERNS: { re: RegExp; what: string }[] = [
  // Named campaigns seen in the wild.
  { re: /\box-alpha\b/i, what: "ox-alpha" },
  { re: /\bundisclosed organization\b/i, what: "undisclosed organization" },
  // "you were made/built/trained by X", "you are actually X", "your real name is X"
  { re: /\byou (?:are|were) (?:actually|really|in fact|secretly)\b/i, what: "false-identity claim" },
  { re: /\byou (?:are|were) (?:made|built|created|developed|trained|trained up) by\b/i, what: "false-provenance claim" },
  { re: /\byour (?:real|true|actual) (?:name|identity|creator|developer|maker)\b/i, what: "false-identity claim" },
  // "claim/say/pretend you are X", "identify yourself as X"
  { re: /\b(?:claim|say|state|pretend|insist|assert)(?:\s+\w+){0,3}\s+(?:that\s+)?you(?:'re| are| were)\b/i, what: "instruction to claim a false identity" },
  { re: /\bidentify yourself as\b/i, what: "instruction to claim a false identity" },
  // "never say/reveal/admit you are X", "deny that you are X"
  { re: /\b(?:never|don't|do not) (?:say|reveal|mention|admit|disclose|tell)(?:\s+\w+){0,3}\s+(?:that\s+)?you(?:'re| are| were)\b/i, what: "instruction to conceal identity" },
  { re: /\bdeny (?:that\s+)?you(?:'re| are| were)\b/i, what: "instruction to conceal identity" },
];

/** What matched in `note`, or null when it is clean. */
export function injectionReason(note: string): string | null {
  for (const p of INJECTION_PATTERNS) if (p.re.test(note)) return p.what;
  return null;
}

/** One dim warning per dropped note. stderr, so it never lands in a piped answer. */
function warnDropped(note: string, reason: string): void {
  const preview = note.replace(/\s+/g, " ").trim().slice(0, 80);
  process.stderr.write(
    `\x1b[33m! memory: dropped a note (${reason}) — prompt injection, not saved: "${preview}${preview.length >= 80 ? "…" : ""}"\x1b[0m\n`,
  );
}

/**
 * Drop every poisoned bullet from a bank body. Returns the cleaned text and what
 * was removed, so the caller can decide whether to warn, rewrite, or both.
 */
export function stripInjectedNotes(content: string): { clean: string; removed: { note: string; reason: string }[] } {
  const removed: { note: string; reason: string }[] = [];
  const clean = content
    .split("\n")
    .filter((line) => {
      const reason = injectionReason(line);
      if (!reason) return true;
      removed.push({ note: line.replace(/^\s*-\s*/, ""), reason });
      return false;
    })
    .join("\n");
  return { clean, removed };
}

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

/** Current memory-bank text for `cwd` ("" if none).
 *
 * Poisoned notes are stripped here rather than only at write time, so a bank
 * written before this guard existed cannot re-inject itself — and the cleaned
 * text is written back, so the note is gone for good rather than being filtered
 * again on every load. */
export async function readMemory(cwd: string): Promise<string> {
  let raw: string;
  try {
    raw = (await fs.readFile(memoryPath(cwd), "utf8")).trim();
  } catch {
    return "";
  }
  const { clean, removed } = stripInjectedNotes(raw);
  if (!removed.length) return raw;
  for (const r of removed) warnDropped(r.note, r.reason);
  // Best-effort: a read-only bank still gets the filtered text, just not the
  // permanent deletion.
  try {
    await writeMemory(cwd, clean);
  } catch {
    /* couldn't rewrite — the caller still only sees the cleaned text */
  }
  return clean.trim();
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
  // Refuse the note outright rather than saving it and filtering it back out on
  // every future read.
  const reason = injectionReason(clean);
  if (reason) {
    warnDropped(clean, reason);
    return countEntries(existing);
  }
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

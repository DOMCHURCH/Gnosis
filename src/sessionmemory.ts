// Automatic session memory: dom learns from every session that touches files,
// with NO user action. After such a turn the engine distills what happened into a
// small structured fact (via a cheap model) and calls recordSession() here. This
// module owns the on-disk memory bank and the boot-time "learned context" that is
// injected into the system prompt — so the model walks into each session knowing
// what worked before, what was decided, and which files matter.
//
// This is distinct from the MANUAL memory bank (memory.ts): that one the model
// writes explicitly with the `memory` tool; this one updates itself. Both live
// under ~/.dom/memory (different filenames), which never leaves the machine — only
// the distilled summary (patterns + decisions) is ever sent to the model.

import { promises as fs } from "node:fs";
import path from "node:path";
import { memoryDir } from "./memory.js";

/** One distilled fact from a single file-touching turn. */
export interface SessionFact {
  sessionId: string;
  timestamp: string; // ISO 8601
  files_touched: string[];
  decision?: string;
  pattern?: string;
  error_recovery?: string;
  userAsk?: string;
}

const MAX_ENTRIES = 50; // per bank file; oldest pruned past this
const PATTERN_THRESHOLD = 3; // a pattern is promoted after this many sightings
const DECISION_MIN_FILES = 2; // a decision is logged when it affects this many files
const DECISION_BUDGET_CHARS = 2000; // ~500 tokens of decisions injected into the prompt

function sessionsDir(): string {
  return path.join(memoryDir(), "sessions");
}
function bankPath(name: "patterns" | "decisions" | "errors" | "files"): string {
  return path.join(memoryDir(), `${name}.md`);
}

async function readText(p: string): Promise<string> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return "";
  }
}

/** Bullet entries ("- …") of a bank file, in order. */
function entriesOf(content: string): string[] {
  return content.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "));
}

/** Rewrite a bank as bullets, newest last, capped at MAX_ENTRIES (oldest pruned). */
async function writeBank(name: "patterns" | "decisions" | "errors" | "files", entries: string[]): Promise<void> {
  await fs.mkdir(memoryDir(), { recursive: true });
  const capped = entries.slice(-MAX_ENTRIES);
  await fs.writeFile(bankPath(name), capped.join("\n") + (capped.length ? "\n" : ""), "utf8");
}

/** Append one bullet to a bank if not already present (dedup), capped + pruned. */
async function appendBank(name: "patterns" | "decisions" | "errors" | "files", text: string): Promise<void> {
  const clean = text.trim().replace(/\s*\n\s*/g, " ");
  if (!clean) return;
  const bullet = `- ${clean}`;
  const cur = entriesOf(await readText(bankPath(name)));
  if (cur.includes(bullet)) return;
  await writeBank(name, [...cur, bullet]);
}

/** Read every stored session fact (across all session files), oldest first. */
export async function allFacts(): Promise<SessionFact[]> {
  let names: string[];
  try {
    names = (await fs.readdir(sessionsDir())).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: SessionFact[] = [];
  for (const n of names.sort()) {
    const arr = JSON.parse((await readText(path.join(sessionsDir(), n))) || "[]") as SessionFact[];
    if (Array.isArray(arr)) out.push(...arr);
  }
  return out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** Number of distinct recorded sessions (one file per date+session). */
async function sessionFileCount(): Promise<number> {
  try {
    return (await fs.readdir(sessionsDir())).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/**
 * Record one distilled fact and roll the derived banks forward:
 *  - sessions/<date>-<id>.json  (append the raw fact)
 *  - files.md      recomputed top touched files (every session)
 *  - errors.md     appended after every error recovery
 *  - decisions.md  appended when a decision affects DECISION_MIN_FILES+ files
 *  - patterns.md   a pattern promoted once seen PATTERN_THRESHOLD+ times
 */
export async function recordSession(fact: SessionFact): Promise<void> {
  await fs.mkdir(sessionsDir(), { recursive: true });
  const date = fact.timestamp.slice(0, 10);
  const file = path.join(sessionsDir(), `${date}-${fact.sessionId}.json`);
  const existing = JSON.parse((await readText(file)) || "[]");
  const arr = Array.isArray(existing) ? existing : [];
  arr.push(fact);
  await fs.writeFile(file, JSON.stringify(arr, null, 2), "utf8");

  const facts = await allFacts();

  // files.md — top touched files with counts, recomputed every session.
  const counts = new Map<string, number>();
  for (const f of facts) for (const p of f.files_touched ?? []) counts.set(p, (counts.get(p) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p, c]) => `- ${p} (${c})`);
  await writeBank("files", ranked);

  // errors.md — after every error recovery.
  if (fact.error_recovery) await appendBank("errors", fact.error_recovery);

  // decisions.md — a decision that affected 2+ files.
  if (fact.decision && (fact.files_touched?.length ?? 0) >= DECISION_MIN_FILES) await appendBank("decisions", fact.decision);

  // patterns.md — promote a pattern once it recurs 3+ times across sessions.
  if (fact.pattern) {
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    const pc = new Map<string, number>();
    for (const f of facts) if (f.pattern) pc.set(norm(f.pattern), (pc.get(norm(f.pattern)) ?? 0) + 1);
    if ((pc.get(norm(fact.pattern)) ?? 0) >= PATTERN_THRESHOLD) await appendBank("patterns", fact.pattern);
  }
}

/**
 * The LEARNED CONTEXT block injected into the system prompt at boot, or "" when
 * no memory exists yet. Only distilled patterns + decisions leave disk — never raw
 * session content. Decisions are truncated to ~500 tokens.
 */
export async function buildLearnedContext(): Promise<string> {
  const sessions = await sessionFileCount();
  if (sessions === 0) return "";
  const patterns = (await readText(bankPath("patterns"))).trim();
  let decisions = (await readText(bankPath("decisions"))).trim();
  if (decisions.length > DECISION_BUDGET_CHARS) decisions = decisions.slice(0, DECISION_BUDGET_CHARS).trimEnd() + "\n- …";
  if (!patterns && !decisions) return "";
  const parts = [`--- Learned context (from ${sessions} session${sessions === 1 ? "" : "s"}) ---`];
  if (patterns) parts.push("Patterns that have worked in this codebase:", patterns);
  if (decisions) parts.push("Decisions already made:", decisions);
  return parts.join("\n");
}

export interface MemoryStats {
  sessions: number;
  files: number;
  oldest: string | null;
}
export async function learnedStats(): Promise<MemoryStats> {
  const facts = await allFacts();
  return {
    sessions: await sessionFileCount(),
    files: entriesOf(await readText(bankPath("files"))).length,
    oldest: facts[0]?.timestamp ?? null,
  };
}

export interface MemoryPanel {
  sessions: number;
  topFiles: { path: string; count: number }[];
  decisions: string[];
}
/** Compact summary for the web MEMORY panel: session count, top 5 files, last 3 decisions. */
export async function panelSummary(): Promise<MemoryPanel> {
  const fileEntries = entriesOf(await readText(bankPath("files")));
  const topFiles = fileEntries.slice(0, 5).map((e) => {
    const m = e.match(/^- (.*) \((\d+)\)$/);
    return m ? { path: m[1]!, count: Number(m[2]) } : { path: e.replace(/^- /, ""), count: 0 };
  });
  const decisions = entriesOf(await readText(bankPath("decisions"))).slice(-3).map((e) => e.replace(/^- /, ""));
  return { sessions: await sessionFileCount(), topFiles, decisions };
}

/** Wipe all automatic session memory (session files + derived banks). */
export async function clearSessionMemory(): Promise<void> {
  await fs.rm(sessionsDir(), { recursive: true, force: true }).catch(() => {});
  for (const n of ["patterns", "decisions", "errors", "files"] as const) {
    await fs.rm(bankPath(n), { force: true }).catch(() => {});
  }
}

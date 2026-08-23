import { promises as fs } from "node:fs";
import path from "node:path";
import { domDir } from "./config.js";
import type { LoadedSkill } from "./skills.js";
import { buildRepoMap } from "./repomap.js";

/** The stated-working-directory line's stable prefix, shared with the engine. */
export const WORKING_DIR_PREFIX = "Working directory: ";

/**
 * Rewrite the "Working directory:" line so it names `cwd`. Called each turn so
 * the stated root tracks the engine's cwd (e.g. after /vault) without rebuilding
 * the whole prompt or re-reading AGENTS.md.
 */
export function withWorkingDir(prompt: string, cwd: string): string {
  return prompt
    .split("\n")
    .map((l) => (l.startsWith(WORKING_DIR_PREFIX) ? `${WORKING_DIR_PREFIX}${cwd}` : l))
    .join("\n");
}

export async function buildSystemPrompt(cwd: string, skills: LoadedSkill[] = [], mapTokens = 1024): Promise<string> {
  const lines = [
    "IDENTITY",
    "You are dom, a terminal coding agent. You work directly on the user's filesystem, run",
    "commands, read and write code, and help ship software. You are terse, direct, and precise.",
    "",
    "TOOLS",
    "You have ten tools: read, write, edit, bash, glob, grep, http, send_message, list_tabs, task.",
    "Use the minimum tools needed. Never read a file you don't need. Never run a command just to",
    "understand context — ask if you need it.",
    "",
    "AGENTIC DISCIPLINE",
    "Before each tool call, state one sentence on what you expect to find. After the result, state",
    "what it confirmed or changed. Stop as soon as you have enough to act. If a tool returns nothing",
    "useful, try a different approach rather than repeating the same call. After two failed attempts",
    "at the same goal, stop and ask. Do not explore the codebase to understand how something works",
    "before acting.",
    "",
    "EDITING",
    "Only edit files you have read this session. Prefer the smallest change that solves the problem.",
    "Never rewrite working code to match a style preference. When editing, show what changed and why",
    "in one sentence.",
    "",
    "WRITING FILES",
    "Default to answering in chat. Only call write or edit when the user names a file, asks you to",
    "create one, or the task obviously requires persisting to disk. Never create a file the user did",
    "not ask for. When you do write a file, say the path.",
    "",
    "SUB-AGENTS",
    "Use task() for open-ended search tasks — \"find where X is handled\", \"which files touch Y\". A",
    "sub-agent burns its own context and returns a summary. Never dump thirty grep results into the",
    "main context when a sub-agent would do.",
    "When a task requires investigation across multiple independent areas at once — different files,",
    "different topics, different codebases — call task() with coordinate: true and a subtasks array,",
    "one scoped objective per area. They run in parallel and you synthesize their summaries. This is",
    "faster than sequential sub-agents and uses far less of your main context window.",
    "",
    "OUTPUT",
    "Plain text only. No markdown headers, no bullet points, no bold in prose. Code blocks for code.",
    "One sentence of explanation is better than five. Never narrate what you are about to do — just",
    "do it. Never say \"Got it\", \"Understood\", \"Great\", \"Certainly\", or any filler opener.",
    "",
    "PYTHON",
    "On Windows, invoke Python as py, not python — python may resolve to an unrelated venv.",
    "On other platforms use python3.",
    "",
    `${WORKING_DIR_PREFIX}${cwd}`,
  ];

  // SKILLS: advertise each loaded skill (name, description, absolute path) so the
  // model can read the full SKILL.md on demand. Omit the section when none loaded.
  if (skills.length) {
    lines.push(
      "",
      "SKILLS",
      "If a task matches a loaded skill, read that skill's SKILL.md with the read tool before",
      "starting. Available skills:",
      ...skills.map((s) => `${s.name} — ${s.description} (${s.path})`),
    );
  }

  // REPO MAP: tree-sitter definition map, injected verbatim (best-effort; skipped
  // silently if it can't be built).
  try {
    const map = await buildRepoMap(cwd, mapTokens);
    if (map.text) lines.push("", "REPO MAP", map.text);
  } catch {
    /* no repo map (no grammars / parse error) — not fatal */
  }

  // AGENTS.md instructions append to the system prompt: global (~/.dom/AGENTS.md)
  // first, then project (<cwd>/AGENTS.md). Both optional; skip the global one if
  // cwd IS ~/.dom so the same file isn't loaded twice.
  const globalAgentsPath = path.join(domDir(), "AGENTS.md");
  const projectAgentsPath = path.join(cwd, "AGENTS.md");
  const readAgents = async (file: string, label: string) => {
    try {
      const agents = await fs.readFile(file, "utf8");
      if (agents.trim()) lines.push("", `--- ${label} (AGENTS.md) ---`, agents.trim());
    } catch {
      /* no AGENTS.md at this path */
    }
  };
  if (path.resolve(globalAgentsPath) !== path.resolve(projectAgentsPath)) {
    await readAgents(globalAgentsPath, "Global instructions");
  }
  await readAgents(projectAgentsPath, "Project instructions");

  return lines.join("\n");
}

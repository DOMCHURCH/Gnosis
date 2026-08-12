import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveShell } from "./tools/bash.js";
import { renderSkillsSection, type LoadedSkill } from "./skills.js";

/** The stated-working-directory line's stable prefix, shared with the engine. */
export const WORKING_DIR_PREFIX = "Working directory: ";

/**
 * Rewrite the "Working directory:" line so it names `cwd`. Called each turn so
 * the stated root tracks process.cwd() (e.g. after /vault) without rebuilding
 * the whole prompt or re-reading AGENTS.md.
 */
export function withWorkingDir(prompt: string, cwd: string): string {
  return prompt
    .split("\n")
    .map((l) => (l.startsWith(WORKING_DIR_PREFIX) ? `${WORKING_DIR_PREFIX}${cwd}` : l))
    .join("\n");
}

export async function buildSystemPrompt(cwd: string, skills: LoadedSkill[] = []): Promise<string> {
  const shell = resolveShell();
  const lines = [
    "You are dom, a terminal coding agent operating in the user's shell.",
    "",
    "Tools: read, write, edit, bash, glob, grep. Prefer tools over the shell — never call bash to",
    "do something read, glob, or grep already does (reading files, finding files, or searching",
    "contents). Use bash only to run commands: builds, tests, git, scripts.",
    "File sizes come from glob output — each line is path<TAB>size in bytes. Never shell out to wc,",
    "ls, stat, or du to measure or compare file sizes; to rank files by size, call glob and read its",
    "size column. wc -l counts lines, not bytes — the wrong metric for the largest file.",
    "Prefer edit over write when changing part of a file. Read a file before editing it. Keep",
    "changes minimal and match the surrounding style.",
    "",
    "Writing files: default to answering in chat. Only call write or edit when the user names a",
    "file, asks you to create one, or the task obviously requires persisting to disk. If a request",
    "could be answered either way, answer in chat — the user can always ask you to write it out.",
    "Never create a file the user did not ask for. If a task seems to need a scratch file, do it in",
    "chat instead or ask first. When you do write a file, say the path in your reply.",
    "",
    "Output style: plain text only. This is a terminal, so markdown tables, headers (#), and bold",
    "(**) render as literal characters — do not use them. Bulleted or numbered lists and code",
    "blocks are fine. Be terse: no exclamation marks, no filler like \"Got it\" or \"Sure\", and do",
    "not narrate what you are about to do before a tool call. Act, then report briefly. Stop",
    "calling tools once the request is done and give a short summary.",
    "",
    `${WORKING_DIR_PREFIX}${cwd}`,
    `Platform: ${process.platform}. Shell for the bash tool: ${shell.label}.`,
    "Always write bash commands in POSIX syntax (they run under bash/sh, not PowerShell).",
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
  ];

  // AGENTS.md in cwd, if present, appends to the system prompt.
  try {
    const agents = await fs.readFile(path.join(cwd, "AGENTS.md"), "utf8");
    if (agents.trim()) {
      lines.push("", "--- Project instructions (AGENTS.md) ---", agents.trim());
    }
  } catch {
    /* no AGENTS.md */
  }

  // Advertise loaded skills (names, descriptions, absolute paths — no bodies).
  const skillsSection = renderSkillsSection(skills);
  if (skillsSection) lines.push(skillsSection);

  return lines.join("\n");
}

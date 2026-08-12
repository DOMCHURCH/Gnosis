// Skills: named procedures the model reads on demand. Each lives at
//   ~/.dom/skills/<name>/SKILL.md        (global)
//   ./.dom/skills/<name>/SKILL.md        (project-local, shadows global)
// with YAML frontmatter (name, description) over a free-form body. At boot we
// parse ONLY the frontmatter and advertise each skill (name, description, and
// the absolute path) in the system prompt — never the body. The model reads the
// full file with the read tool when a task matches.

import { promises as fs } from "node:fs";
import path from "node:path";
import { skillsDir } from "./config.js";

export interface LoadedSkill {
  name: string;
  description: string;
  /** Absolute path to the SKILL.md — what the model reads on demand. */
  path: string;
  scope: "global" | "project";
}

/** Never advertise more than this many skills (keeps the prompt bounded). */
export const MAX_SKILLS = 40;

interface Parsed {
  ok: boolean;
  name?: string;
  description?: string;
  error?: string;
}

/** Parse ONLY the leading `--- ... ---` frontmatter. The body is ignored. */
function parseFrontmatter(text: string): Parsed {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM
  const lines = t.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { ok: false, error: "missing opening --- fence" };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { ok: false, error: "missing closing --- fence" };

  const fields: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const m = lines[i]!.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    fields[m[1]!.toLowerCase()] = v.trim();
  }
  if (!fields.name) return { ok: false, error: "frontmatter is missing 'name'" };
  if (!fields.description) return { ok: false, error: "frontmatter is missing 'description'" };
  return { ok: true, name: fields.name, description: fields.description };
}

async function scanDir(dir: string, scope: "global" | "project", out: LoadedSkill[], warnings: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // directory absent — perfectly normal, not a warning
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(dir, e.name, "SKILL.md");
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      continue; // subdir without a SKILL.md — skip silently
    }
    const parsed = parseFrontmatter(text);
    if (!parsed.ok) {
      warnings.push(`skill ${scope}:${e.name}/SKILL.md — ${parsed.error}; skipped`);
      continue;
    }
    out.push({ name: parsed.name!, description: parsed.description!, path: path.resolve(file), scope });
  }
}

/**
 * Load every skill from the global and project directories. Project-local skills
 * shadow globals of the same name. Malformed files are skipped with a warning,
 * never a crash. Total is capped at MAX_SKILLS.
 */
export async function loadSkills(cwd: string): Promise<{ skills: LoadedSkill[]; warnings: string[] }> {
  const warnings: string[] = [];
  const global: LoadedSkill[] = [];
  const project: LoadedSkill[] = [];
  await scanDir(skillsDir(), "global", global, warnings);
  await scanDir(path.join(cwd, ".dom", "skills"), "project", project, warnings);

  // Project shadows global by name; project entries applied last win.
  const byName = new Map<string, LoadedSkill>();
  for (const s of global) byName.set(s.name, s);
  for (const s of project) byName.set(s.name, s);

  let skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (skills.length > MAX_SKILLS) {
    warnings.push(`skills: found ${skills.length}, capping at ${MAX_SKILLS}`);
    skills = skills.slice(0, MAX_SKILLS);
  }
  return { skills, warnings };
}

/**
 * The system-prompt section: a heading that tells the model to read the matching
 * SKILL.md on demand, then one entry per skill (name, description, absolute
 * path). Returns "" when there are no skills. Bodies are never included.
 */
export function renderSkillsSection(skills: LoadedSkill[]): string {
  if (!skills.length) return "";
  const lines = [
    "",
    "--- Skills ---",
    "You have skills: named procedures for specific tasks. Each entry is a name, a",
    "one-line description, and the absolute path to its SKILL.md. When a task matches",
    "a skill's description, FIRST read that SKILL.md in full with the read tool, then",
    "follow it. Bodies are not included here — read them on demand, only when needed.",
    "",
  ];
  for (const s of skills) {
    lines.push(`- ${s.name} — ${s.description}`);
    lines.push(`  ${s.path}`);
  }
  return lines.join("\n");
}

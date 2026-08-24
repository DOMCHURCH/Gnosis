// Shared ignore logic for glob and grep: a default directory skip-list plus
// .gitignore parsing. `include_ignored` opts back in to everything.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".git",
  "coverage",
  ".dom",
  ".obsidian", // Obsidian's config/workspace dir — never a note
]);

interface Rule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

function translate(p: string): string {
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*") {
      if (p[i + 1] === "*") {
        i++;
        if (p[i + 1] === "/") {
          i++;
          out += "(?:.*/)?"; // **/ matches any number of leading directories
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return out;
}

function compile(line: string): Rule | null {
  let p = line.trim();
  if (!p || p.startsWith("#")) return null;
  let negate = false;
  if (p.startsWith("!")) {
    negate = true;
    p = p.slice(1);
  }
  let dirOnly = false;
  if (p.endsWith("/")) {
    dirOnly = true;
    p = p.slice(0, -1);
  }
  const anchored = p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  const body = translate(p);
  const re = anchored ? new RegExp("^" + body + "(?:/|$)") : new RegExp("(?:^|/)" + body + "(?:/|$)");
  return { re, negate, dirOnly };
}

function loadRules(root: string, filename: string): Rule[] {
  const file = path.join(root, filename);
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .map(compile)
      .filter((r): r is Rule => r !== null);
  } catch {
    return [];
  }
}

// Auto-hidden noise, always excluded (unless include_ignored): dom/Playwright/design
// screenshots, files named after a scraped website, and the Playwright MCP scratch
// dir. These are hidden from the file browser + glob, never deleted.
const AUTO_IGNORE_PATTERNS = [
  "*.png", "*.jpg", "*.jpeg",
  "amazon-*", "apple-*", "google-*", "github-*", "stripe-*",
  ".playwright-mcp/",
];
const AUTO_IGNORE_RULES: Rule[] = AUTO_IGNORE_PATTERNS.map(compile).filter((r): r is Rule => r !== null);

export interface Ignorer {
  ignoreDir(name: string, rel: string): boolean;
  ignoreFile(rel: string): boolean;
}

const ALLOW_ALL: Ignorer = { ignoreDir: () => false, ignoreFile: () => false };

/** `rel` is the path relative to `root`, using forward slashes. */
export function buildIgnorer(root: string, includeIgnored: boolean): Ignorer {
  if (includeIgnored) return ALLOW_ALL;
  // Auto-excludes first, then .gitignore, then .domignore (same gitignore syntax) —
  // later rules (incl. ! negations) win, so .domignore can re-include if needed.
  const rules = [...AUTO_IGNORE_RULES, ...loadRules(root, ".gitignore"), ...loadRules(root, ".domignore")];

  const matched = (rel: string, isDir: boolean): boolean => {
    let ignored = false;
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(rel)) ignored = !r.negate;
    }
    return ignored;
  };

  return {
    ignoreDir(name, rel) {
      if (DEFAULT_IGNORE_DIRS.has(name)) return true;
      return matched(rel, true);
    },
    ignoreFile(rel) {
      return matched(rel, false);
    },
  };
}

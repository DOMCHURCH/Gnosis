// Secret scanning for files the agent writes. Runs between the write landing on
// disk and auto-commit firing, so a leaked key never reaches a commit — but the
// write itself always stands. Blocking a commit is recoverable; silently dropping
// an agent's work is not.
//
// Two rules shape this file:
//
//  1. A detected secret must never reach the model. Findings carry a redacted
//     sample only, because the tool result goes straight back into context, and a
//     key echoed there is a key leaked again — into the transcript, the session
//     file, and the provider's logs.
//  2. False positives must be cheap to live with. Test fixtures legitimately hold
//     key-shaped strings, so .gnosisignore-security exempts paths, and a blocked
//     commit is one `/commit --force` away.

import path from "node:path";
import { promises as fs } from "node:fs";

export interface SecretFinding {
  /** Human name of what matched ("OpenAI API key"). */
  kind: string;
  /** 1-based line number in the scanned file. */
  line: number;
  /** A REDACTED sample — never the raw secret. Safe to show and to log. */
  sample: string;
}

interface Rule {
  kind: string;
  re: RegExp;
}

/**
 * Detection rules. Each is anchored on a provider's own key shape rather than on
 * generic entropy: entropy heuristics fire on minified JS and base64 assets, and
 * a scanner people learn to ignore protects nothing.
 *
 * Rules must not overlap — two rules matching one secret would report it twice.
 */
const RULES: Rule[] = [
  { kind: "Anthropic API key", re: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/g },
  { kind: "Stripe secret key", re: /\b(?:sk|rk)_(?:live|test)_[a-zA-Z0-9]{16,}\b/g },
  // After the two more specific sk- shapes above, so they win on their own keys.
  { kind: "OpenAI API key", re: /\bsk-(?!ant-)[a-zA-Z0-9]{20,}\b/g },
  { kind: "npm token", re: /\bnpm_[a-zA-Z0-9]{36}\b/g },
  // ghp_/gho_/ghs_/ghu_ share a shape, so they are one rule, not several.
  { kind: "GitHub token", re: /\bgh[opsu]_[a-zA-Z0-9]{36}\b/g },
  { kind: "AWS access key ID", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "Slack token", re: /\bxox[abposr]-[0-9a-zA-Z-]{10,}\b/g },
  { kind: "private key block", re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g },
  // Deliberately narrow: a quoted literal of real length assigned to a
  // password-ish name. `password = getenv(...)` and empty defaults do not match.
  { kind: "hardcoded password", re: /\b(?:password|passwd|pwd|secret)\s*[:=]\s*["'][^"'\s]{6,}["']/gi },
];

/** Mask all but the first four characters, and never echo more than a stub. */
export function redact(raw: string): string {
  const head = raw.slice(0, 4);
  return `${head}${"*".repeat(Math.max(4, Math.min(12, raw.length - 4)))}`;
}

/** A line this long is minified output, not source. Scanning it is where false
 *  positives come from. */
const MAX_LINE = 2000;

/**
 * Scan text for secrets. Pure and synchronous so the write path pays almost
 * nothing: this runs on every successful write.
 */
export function scanText(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((lineText, i) => {
    if (lineText.length > MAX_LINE) return;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.re.exec(lineText)) !== null) {
        findings.push({ kind: rule.kind, line: i + 1, sample: redact(m[0]) });
        if (!rule.re.global) break;
      }
    }
  });
  // One finding per (kind, line): a key repeated on a line is one problem.
  const seen = new Set<string>();
  return findings.filter((f) => {
    const k = `${f.kind}:${f.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The name of the exemption file, kept beside .gitignore in the repo root. */
export const SECURITY_IGNORE_FILE = ".gnosisignore-security";

/**
 * Load exemption patterns. Same spirit as .gitignore but deliberately simpler:
 * one path fragment or glob per line, `#` comments, blank lines ignored. Test
 * fixtures full of key-shaped strings are the reason this exists.
 */
export async function loadSecurityIgnore(root: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(root, SECURITY_IGNORE_FILE), "utf8");
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

/** Does `rel` (a repo-relative, forward-slashed path) match an exemption? */
export function isExempt(rel: string, patterns: string[]): boolean {
  const p = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  return patterns.some((pat) => {
    const clean = pat.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!clean) return false;
    // A bare directory name exempts everything under it.
    if (p === clean || p.startsWith(`${clean.replace(/\/$/, "")}/`)) return true;
    return globMatch(p, clean);
  });
}

/**
 * Minimal glob: `*` within a segment, `**` across segments, `?` one character.
 *
 * Translated in ONE pass rather than by chained replaces through a placeholder
 * character. A placeholder is indistinguishable from that same character
 * appearing in the pattern itself, which makes the translation quietly wrong.
 */
function globMatch(value: string, pattern: string): boolean {
  const SPECIAL = ".+^${}()|[]\\";
  let rx = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        rx += ".*";
        i++;
      } else {
        rx += "[^/]*";
      }
    } else if (c === "?") {
      rx += "[^/]";
    } else if (SPECIAL.includes(c)) {
      rx += `\\${c}`;
    } else {
      rx += c;
    }
  }
  try {
    return new RegExp(`^${rx}$`).test(value);
  } catch {
    return false;
  }
}

export interface ScanResult {
  findings: SecretFinding[];
  /** True when the path was exempted by .gnosisignore-security. */
  exempt: boolean;
}

/** Scan one file on disk, honouring the repo's exemptions. Never throws. */
export async function scanFile(absPath: string, root: string): Promise<ScanResult> {
  const rel = path.relative(root, absPath).split(path.sep).join("/");
  const patterns = await loadSecurityIgnore(root);
  if (isExempt(rel, patterns)) return { findings: [], exempt: true };
  try {
    const text = await fs.readFile(absPath, "utf8");
    return { findings: scanText(text), exempt: false };
  } catch {
    return { findings: [], exempt: false };
  }
}

/** The one-line warning shown in the transcript when a commit is blocked. */
export function warningLine(rel: string, findings: SecretFinding[]): string {
  const f = findings[0]!;
  const more = findings.length > 1 ? ` (+${findings.length - 1} more)` : "";
  return `⚠ security: possible ${f.kind} on line ${f.line} of ${rel} — auto-commit blocked${more}`;
}

/**
 * What the MODEL is told. Names the problem and the location so it can fix it,
 * and carries only the redacted sample — rule 1 from the header.
 */
export function toolNote(findings: SecretFinding[]): string {
  const list = findings.map((f) => `line ${f.line}: ${f.kind} (${f.sample})`).join("; ");
  return (
    `Security scan flagged this file, so auto-commit was blocked: ${list}. ` +
    `The file was still written. Replace the value with an environment variable reference, or if this is an ` +
    `intentional fixture add its path to ${SECURITY_IGNORE_FILE}. The user can override with /commit --force.`
  );
}

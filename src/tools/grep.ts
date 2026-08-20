import { execa } from "execa";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { truncateOutput } from "./truncate.js";
import { globToRegExp } from "./glob.js";
import { buildIgnorer, DEFAULT_IGNORE_DIRS } from "./ignore.js";
import type { GrepArgs } from "./schemas.js";
import type { ToolContext, ToolResult } from "./index.js";

/**
 * Normalize one ripgrep output line's leading path to forward slashes. rg emits
 * Windows-style `.\src\a.ts:1:...`; we strip a leading ./ or .\ and swap
 * backslashes to / in the path segment only — content (m[3]) is left untouched.
 */
export function normalizeRgLine(line: string): string {
  const m = /^(.*?):(\d+):(.*)$/.exec(line);
  if (!m) return line;
  const p = m[1]!.replace(/^\.[\\/]/, "").replace(/\\/g, "/");
  return `${p}:${m[2]}:${m[3]}`;
}

function rgPath(): string | null {
  if (existsSync("/usr/bin/rg")) return "/usr/bin/rg";
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  const exts = process.platform === "win32" ? [".exe", ""] : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, "rg" + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

async function runRipgrep(rg: string, args: GrepArgs, cwd: string): Promise<ToolResult> {
  const argv = ["--line-number", "--no-heading", "--color", "never"];
  if (args.include_ignored) {
    argv.push("--no-ignore", "--hidden"); // opt back in to everything
  } else {
    // rg already respects .gitignore; also force-skip the default set.
    for (const d of DEFAULT_IGNORE_DIRS) argv.push("-g", `!${d}`);
  }
  if (args.glob) argv.push("--glob", args.glob);
  argv.push("-e", args.pattern);
  argv.push(args.path ? path.resolve(cwd, args.path) : ".");

  const res = await execa(rg, argv, {
    cwd,
    reject: false,
    all: false,
    timeout: 60_000,
    windowsHide: true,
  });
  if (res.exitCode === 1 && !res.stderr) {
    return { output: `No matches for /${args.pattern}/`, isError: false };
  }
  if (res.exitCode && res.exitCode > 1) {
    return { output: `grep: ${res.stderr || "ripgrep failed"}`, isError: true };
  }
  const out = res.stdout
    .split("\n")
    .map((l) => (l ? normalizeRgLine(l) : l))
    .join("\n")
    .trim();
  return { output: truncateOutput(out || `No matches for /${args.pattern}/`), isError: false };
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

async function jsFallback(args: GrepArgs, cwd: string): Promise<ToolResult> {
  let re: RegExp;
  try {
    re = new RegExp(args.pattern);
  } catch (e) {
    return { output: `grep: invalid pattern: ${(e as Error).message}`, isError: true };
  }
  const globRe = args.glob ? globToRegExp(args.glob) : null;
  const base = path.resolve(cwd, args.path ?? ".");
  const ig = buildIgnorer(base, args.include_ignored ?? false);
  const results: string[] = [];

  const search = async (file: string, rel: string) => {
    let buf: Buffer;
    try {
      buf = await fs.readFile(file);
    } catch {
      return;
    }
    if (looksBinary(buf)) return;
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) results.push(`${rel}:${i + 1}:${lines[i]}`);
    }
  };

  const walk = async (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relBase = path.relative(base, full).split(path.sep).join("/");
      const relDisplay = path.relative(cwd, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (ig.ignoreDir(entry.name, relBase)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        if (ig.ignoreFile(relBase)) continue;
        if (globRe && !globRe.test(relDisplay)) continue;
        await search(full, relDisplay);
      }
    }
  };

  const stat = await fs.stat(base).catch(() => null);
  if (stat?.isFile()) {
    await search(base, path.relative(cwd, base).split(path.sep).join("/"));
  } else {
    await walk(base);
  }

  return {
    output: truncateOutput(results.join("\n") || `No matches for /${args.pattern}/`),
    isError: false,
  };
}

export async function runGrep(args: GrepArgs, _signal?: AbortSignal, ctx?: ToolContext): Promise<ToolResult> {
  // Multi-root: no explicit path + 2+ workspace roots → grep each root, then
  // prefix every match line with its root name. Single-root path unchanged below.
  const roots = ctx?.roots ?? [];
  if (!args.path && roots.length > 1) {
    const chunks: string[] = [];
    for (const root of roots) {
      const r = await runGrep(args, _signal, { ...ctx, cwd: root, roots: undefined });
      if (r.isError) return r;
      if (/^No matches for/.test(r.output)) continue;
      const label = path.basename(root);
      chunks.push(r.output.split("\n").map((l) => `${label}/${l}`).join("\n"));
    }
    return {
      output: chunks.length ? truncateOutput(chunks.join("\n")) : `No matches for /${args.pattern}/`,
      isError: false,
    };
  }

  const cwd = ctx?.cwd ?? process.cwd();
  const rg = rgPath();
  if (rg) {
    try {
      return await runRipgrep(rg, args, cwd);
    } catch {
      /* fall through to JS */
    }
  }
  return jsFallback(args, cwd);
}

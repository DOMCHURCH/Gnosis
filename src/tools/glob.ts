import { promises as fs } from "node:fs";
import path from "node:path";
import { truncateOutput } from "./truncate.js";
import { buildIgnorer, type Ignorer } from "./ignore.js";
import type { GlobArgs } from "./schemas.js";
import type { ToolContext, ToolResult } from "./index.js";
import { resolveUserPath } from "../homepath.js";

/** Translate a glob pattern into an anchored RegExp over POSIX-style paths. */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** — cross directory boundaries
        i++;
        if (pattern[i + 1] === "/") i++;
        re += "(?:.*/)?";
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Split a brace body on top-level commas, honoring nesting and escapes. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let k = 0; k < body.length; k++) {
    const c = body[k]!;
    if (c === "\\") {
      cur += c + (body[k + 1] ?? "");
      k++;
    } else if (c === "{") {
      depth++;
      cur += c;
    } else if (c === "}") {
      depth--;
      cur += c;
    } else if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts;
}

/**
 * Expand shell-style brace alternation into a list of brace-free patterns, the
 * same way a shell / ripgrep would. Handles nesting and multiple groups; an
 * escaped \{ (or a group with no comma) is left literal, not expanded.
 */
export function expandBraces(pattern: string): string[] {
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") {
      i++; // skip the escaped char — never a delimiter
      continue;
    }
    if (c === "{") {
      let depth = 0;
      let hasComma = false;
      let j = i;
      for (; j < pattern.length; j++) {
        const cj = pattern[j]!;
        if (cj === "\\") {
          j++;
          continue;
        }
        if (cj === "{") depth++;
        else if (cj === "}") {
          depth--;
          if (depth === 0) break;
        } else if (cj === "," && depth === 1) hasComma = true;
      }
      if (j < pattern.length && depth === 0 && hasComma) {
        const prefix = pattern.slice(0, i);
        const suffix = pattern.slice(j + 1);
        const out: string[] = [];
        for (const opt of splitTopLevel(pattern.slice(i + 1, j))) {
          out.push(...expandBraces(prefix + opt + suffix));
        }
        return out;
      }
      // unbalanced or comma-less group → literal brace, keep scanning past it
    }
  }
  return [pattern];
}

/** Drop the backslash from escaped braces/commas so they match as literals. */
function unescapeBraces(pattern: string): string {
  return pattern.replace(/\\([{},])/g, "$1");
}

/** Compile a (possibly braced) glob into a predicate over POSIX-style paths. */
function compileGlob(pattern: string): (rel: string) => boolean {
  const res = expandBraces(pattern).map((p) => globToRegExp(unescapeBraces(p)));
  return (rel) => res.some((re) => re.test(rel));
}

interface Found {
  rel: string;
  mtime: number;
  size: number;
}

async function walk(
  root: string,
  base: string,
  match: (rel: string) => boolean,
  ig: Ignorer,
  out: Found[],
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (ig.ignoreDir(entry.name, rel)) continue;
      await walk(full, base, match, ig, out);
    } else if (entry.isFile()) {
      if (ig.ignoreFile(rel)) continue;
      if (!match(rel)) continue;
      try {
        const st = await fs.stat(full);
        out.push({ rel, mtime: st.mtimeMs, size: st.size });
      } catch {
        /* skip */
      }
    }
  }
}

export async function runGlob(args: GlobArgs, _signal?: AbortSignal, ctx?: ToolContext): Promise<ToolResult> {
  // Multi-root: no explicit path + 2+ workspace roots → glob each root, then
  // prefix every hit with its root name. Single-root path is left untouched below.
  const roots = ctx?.roots ?? [];
  if (!args.path && roots.length > 1) {
    const merged: string[] = [];
    for (const root of roots) {
      const r = await runGlob(args, _signal, { ...ctx, cwd: root, roots: undefined });
      if (/^No files matching/.test(r.output)) continue;
      const label = path.basename(root);
      for (const line of r.output.split("\n")) merged.push(`${label}/${line}`);
    }
    return {
      output: merged.length ? truncateOutput(merged.join("\n")) : `No files matching ${args.pattern}`,
      isError: false,
    };
  }

  const base = resolveUserPath(ctx?.cwd ?? process.cwd(), args.path ?? ".");
  const match = compileGlob(args.pattern);
  const ig = buildIgnorer(base, args.include_ignored ?? false);
  const found: Found[] = [];
  await walk(base, base, match, ig, found);
  found.sort((a, b) => b.mtime - a.mtime); // mtime desc
  if (found.length === 0) {
    return { output: `No files matching ${args.pattern}`, isError: false };
  }
  // path<TAB>size(bytes), so the model can rank by size without shelling out.
  return { output: truncateOutput(found.map((f) => `${f.rel}\t${f.size}`).join("\n")), isError: false };
}

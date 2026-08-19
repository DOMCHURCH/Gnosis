// Compact tool-call rendering. A tool call shows as a one-line call signature
// (● Read(src/engine.ts)) and a one-line summarized result, instead of echoing
// raw args and dumping output. Pure functions so both the transient "running"
// indicator and the committed transcript entry share them, and so they're
// unit-testable. Errors are never summarized — the caller passes the full text.

import { diffLines } from "diff";

const CONNECTOR = "  ⎿ ";
const CONT_INDENT = "    "; // continuation lines align under the connector text

export interface CallParts {
  /** Capitalized tool name, e.g. "Read". */
  tool: string;
  /** Primary arg, shown unquoted inside the parens. */
  primary: string;
  /** Behavior-changing extras only, e.g. ", replace_all" ("" when none). */
  secondary: string;
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}
function stripScheme(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "");
}
function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
function n(count: number, word: string, plural = word + "s"): string {
  return `${count} ${count === 1 ? word : plural}`;
}

/** The pieces of a call signature. Primary is the one arg worth showing; secondary
 * holds only flags that change behavior (so a call reads like a function call). */
export function callParts(name: string, args: any): CallParts {
  const a = args ?? {};
  let primary = "";
  let secondary = "";
  switch (name) {
    case "read":
    case "write":
    case "edit":
    case "view_image":
      primary = String(a.path ?? "");
      break;
    case "glob":
    case "grep":
      primary = String(a.pattern ?? "");
      break;
    case "bash":
      primary = String(a.command ?? "").replace(/\s+/g, " ").trim();
      break;
    case "http":
      primary = `${String(a.method ?? "GET").toUpperCase()} ${stripScheme(String(a.url ?? ""))}`;
      break;
    case "send_message":
      primary = String(a.tab ?? "");
      break;
    case "task":
      primary = String(a.description ?? "");
      break;
    case "web_search":
      primary = String(a.query ?? "");
      break;
    case "todo": {
      const count = Array.isArray(a.items) ? a.items.length : 0;
      primary = `${count} task${count === 1 ? "" : "s"}`;
      break;
    }
    default: {
      const first = Object.values(a).find((v) => typeof v === "string");
      primary = first ? String(first) : "";
    }
  }
  if (name === "edit") {
    if (Array.isArray(a.edits) && a.edits.length) secondary = `, ${a.edits.length} edit${a.edits.length === 1 ? "" : "s"}`;
    else if (a.replace_all) secondary = ", replace_all";
  }
  return { tool: capitalize(name), primary, secondary };
}

/** Truncate from the LEFT with an ellipsis, so a long path keeps its tail. */
export function leftTruncate(s: string, max: number): string {
  if (max <= 1) return s.length ? "…" : "";
  return s.length <= max ? s : "…" + s.slice(s.length - (max - 1));
}

/** The `● Read(src/engine.ts)` call line, left-truncating a long primary to fit. */
export function callLine(parts: CallParts, width: number): string {
  const fixed = 2 /* "● " */ + parts.tool.length + 2 /* () */ + parts.secondary.length;
  const budget = Math.max(4, width - fixed);
  return `● ${parts.tool}(${leftTruncate(parts.primary, budget)}${parts.secondary})`;
}

// --- result summaries -------------------------------------------------------

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function summarizeHttp(output: string): string {
  const lines = output.split("\n");
  const status = (lines.find((l) => /^\d{3} /.test(l)) ?? "").trim();
  const ctLine = lines.find((l) => /^< content-type:/i.test(l)) ?? "";
  const ct = ((ctLine.split(/:(.+)/)[1] ?? "").trim().split(";")[0] ?? "").trim();
  const kind = ct.includes("json") ? "json" : ct.includes("html") ? "html" : ct.split("/")[1] || "";
  const clLine = lines.find((l) => /^< content-length:/i.test(l));
  const cl = clLine ? Number(clLine.split(/:(.+)/)[1]) : NaN;
  const blanks: number[] = [];
  lines.forEach((l, i) => l === "" && blanks.push(i)); // echo, "", status+headers, "", body
  const body = blanks.length >= 2 ? lines.slice(blanks[1]! + 1).join("\n") : "";
  const bytes = Number.isFinite(cl) ? cl : Buffer.byteLength(body, "utf8");
  return [status, `${fmtBytes(bytes)}${kind ? " " + kind : ""}`].filter(Boolean).join(" · ");
}

/** bash (and any unlisted tool): first 3 lines, then a "+N lines" marker. */
function firstLines(output: string): string {
  const lines = output.replace(/\n+$/, "").split("\n");
  if (lines.length <= 3) return lines.join("\n");
  return lines.slice(0, 3).join("\n") + `\n+${n(lines.length - 3, "line")}`;
}

/** One-line (bash: up to 4-line) summary of a SUCCESSFUL result. Never called for
 * errors — the caller shows the full error text unsummarized. */
export function summarizeResult(name: string, args: any, output: string): string {
  const a = args ?? {};
  switch (name) {
    case "read": {
      const lines = output.split("\n").filter((l) => /^\s*\d+ {2}/.test(l)).length;
      return `Read ${n(lines, "line")}`;
    }
    case "write": {
      const m = output.match(/Wrote \d+ bytes \((\d+) lines?\) to (.+)/);
      return m ? `Wrote ${n(Number(m[1]), "line")} to ${basename(m[2]!)}` : (output.split("\n")[0] ?? "");
    }
    case "edit": {
      const list =
        Array.isArray(a.edits) && a.edits.length
          ? a.edits
          : [{ old_str: a.old_str, new_str: a.new_str, replace_all: a.replace_all }];
      let added = 0, removed = 0;
      for (const ed of list) {
        for (const p of diffLines(String(ed.old_str ?? ""), String(ed.new_str ?? ""))) {
          if (p.added) added += p.count ?? 0;
          else if (p.removed) removed += p.count ?? 0;
        }
      }
      // A single replace_all edit hit N occurrences — scale the per-edit diff by
      // the reported replacement count (matches the pre-batch behavior).
      const reps = Number((output.match(/— (\d+) replacement/) ?? [])[1] ?? 1) || 1;
      const scale = list.length === 1 && list[0]?.replace_all && reps > 0 ? reps : 1;
      const prefix = list.length > 1 ? `${list.length} edits · ` : "";
      return `${prefix}Added ${n(added * scale, "line")}, removed ${n(removed * scale, "line")}`;
    }
    case "grep": {
      if (/^No matches/.test(output)) return "No matches";
      const rows = output.split("\n").map((l) => /^(.+?):(\d+):/.exec(l)).filter(Boolean) as RegExpExecArray[];
      const files = new Set(rows.map((m) => m[1]));
      return `${n(rows.length, "match", "matches")} in ${n(files.size, "file")}`;
    }
    case "glob": {
      if (/^No files/.test(output)) return "No files";
      const files = output.split("\n").filter((l) => l.trim() && !l.startsWith("[")).length;
      return n(files, "file");
    }
    case "http":
      return summarizeHttp(output);
    case "web_search": {
      if (/^No results/.test(output)) return "No results";
      const m = output.match(/^(\d+) result/);
      return m ? `${Number(m[1])} result${Number(m[1]) === 1 ? "" : "s"}` : firstLines(output);
    }
    case "task":
      // Already "<n> tools · <n> tokens\n<summary>" — show it whole, not truncated.
      return output;
    default:
      return firstLines(output);
  }
}

/** The result text to render: the FULL output for errors (never summarized) and
 * for /verbose; otherwise a one-line summary. */
export function resultBody(opts: { isError: boolean; verbose: boolean; name: string; args: any; output: string }): string {
  if (opts.isError || opts.verbose) return opts.output;
  return summarizeResult(opts.name, opts.args, opts.output);
}

/** The indented result block: a connector line plus aligned continuation lines. */
export function resultLines(body: string): string[] {
  if (!body) return [];
  const lines = body.split("\n");
  const out = [CONNECTOR + (lines[0] ?? "")];
  for (let i = 1; i < lines.length; i++) out.push(CONT_INDENT + lines[i]);
  return out;
}

/** All terminal lines for a committed tool entry (call line + result block). */
export function toolEntryLines(entry: CallParts & { body: string }, width: number): string[] {
  return [callLine(entry, width), ...resultLines(entry.body)];
}

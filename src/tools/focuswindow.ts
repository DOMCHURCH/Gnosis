// Bringing another application to the foreground, and listing what is open.
//
// Windows refuses SetForegroundWindow to a process that does not own the
// foreground or a recent input event — the anti-focus-stealing rule. That is why
// a synthesised click can land in the wrong application: the click goes to
// whatever Windows has in front, not to the window the agent believes it is
// driving.
//
// The textbook fix is AttachThreadInput + SetForegroundWindow via Add-Type
// P/Invoke. DO NOT reintroduce it. Windows Defender's AMSI scans script content
// and blocks exactly that combination as a known malware pattern — it was tried
// here and refused outright with "This script contains malicious content and has
// been blocked by your antivirus software", which is a failure the user cannot
// act on and the agent cannot retry its way out of.
//
// WScript.Shell's AppActivate does the same job through a documented COM API
// that AMSI does not flag. It is slightly weaker — it can decline on a window
// that is minimised behind a modal — which is why it retries once, and why a
// false result is reported honestly rather than dressed up as success.
//
// This lives in src/ rather than in the Electron shell so the CLI and the
// desktop app share one implementation; electron/win32-focus.js imports it for
// its IPC handlers.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { FocusWindowArgs } from "./schemas.js";
import type { ToolContext, ToolResult } from "./index.js";

const PS = "powershell.exe";

export interface WindowInfo {
  pid: number;
  name: string;
  title: string;
}

/** PowerShell writes progress records to stderr as a CLIXML blob. It is noise,
 * and handing it to the model as "the error" tells nobody anything. Pull the
 * real message out of it when there is one. */
function cleanError(stderr: string, fallback: string): string {
  const text = String(stderr ?? "");
  if (!text.trim()) return fallback;
  if (!text.startsWith("#< CLIXML")) return text.trim().split("\n")[0] ?? fallback;
  const errs = [...text.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
    .map((m) => (m[1] ?? "").replace(/_x000D_|_x000A_/g, "").trim())
    .filter(Boolean);
  return errs.length ? errs.join(" ").slice(0, 300) : fallback;
}

/**
 * Run a script by writing it to a temp .ps1 and executing it with -File.
 *
 * -File rather than -Command: a multi-line script handed to PowerShell's
 * command-line parser is at the mercy of how it splits arguments, and the
 * failure mode is a bare "At line:1 char:1" that says nothing about the cause.
 * A file is parsed as a file.
 */
async function run(script: string, timeout = 20000): Promise<{ ok: boolean; stdout?: string; error?: string }> {
  const file = path.join(os.tmpdir(), `gnosis-ps-${crypto.randomBytes(6).toString("hex")}.ps1`);
  // UTF-8 with a BOM, so PowerShell 5.1 reads non-ASCII window titles correctly.
  await fs.writeFile(file, "﻿" + script, "utf8");
  try {
    return await new Promise((resolve) => {
      const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file];
      execFile(PS, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) resolve({ ok: false, error: cleanError(String(stderr), String(err.message)) });
        else resolve({ ok: true, stdout: String(stdout) });
      });
    });
  } finally {
    await fs.rm(file, { force: true }).catch(() => {});
  }
}

const LIST_SCRIPT = `
$ErrorActionPreference='Stop'
Get-Process |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |
  Select-Object -Property @{N='pid';E={$_.Id}}, @{N='name';E={$_.ProcessName}}, @{N='title';E={$_.MainWindowTitle}} |
  ConvertTo-Json -Compress -Depth 3
`;

const focusScript = (pid: number) => `
$ErrorActionPreference='Stop'
$p = Get-Process -Id ${pid} -ErrorAction Stop
if ($p.MainWindowHandle -eq 0) { throw "process ${pid} has no main window" }
$sh = New-Object -ComObject WScript.Shell
$ok = $sh.AppActivate($p.Id)
if (-not $ok) { Start-Sleep -Milliseconds 150; $ok = $sh.AppActivate($p.Id) }
ConvertTo-Json -Compress @{ ok = [bool]$ok; pid = $p.Id; title = $p.MainWindowTitle }
`;

/** Every process that owns a visible top-level window. */
export async function listWindows(): Promise<{ ok: boolean; windows?: WindowInfo[]; error?: string }> {
  if (process.platform !== "win32") return { ok: false, error: "Windows only." };
  const r = await run(LIST_SCRIPT);
  if (!r.ok) return { ok: false, error: r.error };
  const text = (r.stdout ?? "").trim();
  if (!text) return { ok: true, windows: [] };
  try {
    const parsed = JSON.parse(text);
    // ConvertTo-Json emits a bare object, not an array, for a single result.
    const arr: WindowInfo[] = Array.isArray(parsed) ? parsed : [parsed];
    return { ok: true, windows: arr.filter((w) => w && w.pid) };
  } catch (e) {
    return { ok: false, error: `could not parse window list: ${(e as Error).message}` };
  }
}

/** Raise a window by pid, or by a case-insensitive match on process name/title. */
export async function focusWindow(arg: { pid?: number; app?: string }): Promise<{
  ok: boolean; pid?: number; title?: string; matched?: string | null; error?: string; open?: string[];
}> {
  if (process.platform !== "win32") return { ok: false, error: "Windows only." };

  let target = arg.pid;
  let matched: WindowInfo | null = null;
  if (!target) {
    const needle = String(arg.app ?? "").trim().toLowerCase();
    if (!needle) return { ok: false, error: "Give a pid or an app name." };
    const list = await listWindows();
    if (!list.ok) return { ok: false, error: list.error };
    const windows = list.windows ?? [];
    // Prefer a process-name hit over a title hit: "code" should mean VS Code,
    // not whichever window happens to have "code" in its document name.
    matched =
      windows.find((w) => w.name.toLowerCase() === needle) ??
      windows.find((w) => w.name.toLowerCase().includes(needle)) ??
      windows.find((w) => w.title.toLowerCase().includes(needle)) ??
      null;
    if (!matched) {
      return { ok: false, error: `No open window matches ${JSON.stringify(arg.app)}.`, open: windows.map((w) => w.name) };
    }
    target = matched.pid;
  }

  const r = await run(focusScript(Number(target)));
  if (!r.ok) return { ok: false, error: r.error };
  try {
    const out = JSON.parse((r.stdout ?? "").trim());
    return { ok: !!out.ok, pid: out.pid, title: out.title, matched: matched?.name ?? null };
  } catch {
    return { ok: false, error: "focus call returned nothing parseable" };
  }
}

/** The agent-facing tool. */
export async function runFocusWindow(args: FocusWindowArgs, _signal?: AbortSignal, _ctx?: ToolContext): Promise<ToolResult> {
  if (args.action === "list") {
    const r = await listWindows();
    if (!r.ok) return { output: `focus_window: ${r.error}`, isError: true };
    const rows = (r.windows ?? []).map((w) => `${w.pid}\t${w.name}\t${w.title}`);
    return { output: rows.length ? `pid\tprocess\ttitle\n${rows.join("\n")}` : "No windows are open.", isError: false };
  }

  const r = await focusWindow({ app: args.app, pid: args.pid });
  if (!r.ok) {
    const hint = r.open?.length ? `\nOpen now: ${[...new Set(r.open)].join(", ")}` : "";
    return { output: `focus_window: ${r.error}${hint}`, isError: true };
  }
  return { output: `Focused ${r.matched ?? r.pid} — "${r.title}". It is now the foreground window.`, isError: false };
}

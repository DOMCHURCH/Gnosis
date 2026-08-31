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

// AppActivate is tried by PID and then by TITLE. They are not equivalent: the
// PID form asks the shell to activate a process's main window, and it declines
// on windows it does not consider a normal top-level target — MSI Afterburner is
// one, and it returns false there while the window is plainly on screen. The
// title form goes through the same documented COM API (so still no AMSI
// problem) but resolves the window differently, and succeeds on several of the
// cases the PID form refuses. Trailing whitespace is trimmed because window
// titles routinely carry it ("MSI Afterburner ") and AppActivate matches on a
// prefix, so the untrimmed string can miss its own window.
const focusScript = (pid: number) => `
$ErrorActionPreference='Stop'
$p = Get-Process -Id ${pid} -ErrorAction Stop
if ($p.MainWindowHandle -eq 0) { throw "process ${pid} has no main window" }
$sh = New-Object -ComObject WScript.Shell
$ok = $sh.AppActivate($p.Id)
if (-not $ok) { Start-Sleep -Milliseconds 150; $ok = $sh.AppActivate($p.Id) }
if (-not $ok) {
  $t = ($p.MainWindowTitle).Trim()
  if ($t) {
    $ok = $sh.AppActivate($t)
    if (-not $ok) { Start-Sleep -Milliseconds 150; $ok = $sh.AppActivate($t) }
  }
}
# Why it refused, when it did. A process running as administrator cannot be
# brought forward by a process that is not (Windows UIPI), and no choice of API
# changes that — MSI Afterburner is the common example, since it needs admin for
# hardware access. Reading .Path fails or comes back empty across that boundary,
# which is a good enough signal to stop guessing and tell the user to click it.
$elevated = $false
if (-not $ok) { try { $elevated = [string]::IsNullOrEmpty($p.Path) } catch { $elevated = $true } }
ConvertTo-Json -Compress @{ ok = [bool]$ok; pid = $p.Id; title = $p.MainWindowTitle; elevated = [bool]$elevated }
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

/**
 * Fold a name to its comparable form: lowercase, no .exe, no punctuation or
 * spaces.
 *
 * This is what makes "MSI Afterburner" find the process `MSIAfterburner.exe`.
 * The naive comparison was `processName.includes(userText)`, which fails on that
 * pair for the least interesting reason imaginable — the user types the product
 * name with a space and Windows names the executable without one. Observed
 * live: the app launched fine, its window opened fine, and launchApp reported
 * "started but no window appeared" because "msiafterburner" does not contain
 * "msi afterburner". The model believed the launch had failed and went hunting
 * the taskbar by pixel.
 *
 * Also covers the ordinary cases: "VS Code" / "Code", "note pad" / "notepad".
 */
function fold(s: string): string {
  return String(s ?? "").toLowerCase().replace(/\.exe$/, "").replace(/[^a-z0-9]/g, "");
}

/**
 * Find the window a user's words meant, over process name AND title.
 *
 * Ordered most to least specific, and a process-name hit beats a title hit:
 * "code" should mean VS Code, not whichever window happens to have the word
 * "code" in its document name.
 */
export function matchWindow(windows: WindowInfo[], app: string): WindowInfo | null {
  return matchWindowDetailed(windows, app).window;
}

/**
 * As matchWindow, but says HOW it matched.
 *
 * A title match is a guess and has to be labelled as one. Live example from this
 * machine: VS Code had a file called `notepad` open, so its window title was
 * "notepad - Untitled (Workspace) - Visual Studio Code" — and "focus notepad"
 * matched VS Code. Focusing the wrong window is the precise failure this whole
 * module exists to prevent, because the keystrokes that follow go somewhere real.
 *
 * A process-name match is trustworthy and stays silent. A title match is
 * reported, so the tool result can name the window it actually raised and the
 * model can notice it got something it did not ask for.
 */
export function matchWindowDetailed(
  windows: WindowInfo[],
  app: string,
): { window: WindowInfo | null; by: "name" | "title" | null } {
  const n = fold(app);
  if (!n) return { window: null, by: null };
  const byName =
    windows.find((w) => fold(w.name) === n) ??
    windows.find((w) => fold(w.name).startsWith(n)) ??
    windows.find((w) => fold(w.name).includes(n));
  if (byName) return { window: byName, by: "name" };
  const byTitle =
    windows.find((w) => fold(w.title) === n) ??
    windows.find((w) => fold(w.title).startsWith(n)) ??
    windows.find((w) => fold(w.title).includes(n));
  return byTitle ? { window: byTitle, by: "title" } : { window: null, by: null };
}

/** Raise a window by pid, or by a case-insensitive match on process name/title. */
export async function focusWindow(arg: { pid?: number; app?: string }): Promise<{
  ok: boolean; pid?: number; title?: string; matched?: string | null; error?: string; open?: string[];
  /** Set only when the window was found by its TITLE rather than its process
   * name — i.e. the match is a guess and the caller should say which window it
   * actually raised. See matchWindowDetailed(). */
  matchedByTitle?: boolean;
  /** The target runs elevated and we do not, so Windows will not let us raise
   * it. Not a bug to retry — a security boundary to report. */
  elevated?: boolean;
}> {
  if (process.platform !== "win32") return { ok: false, error: "Windows only." };

  let target = arg.pid;
  let matched: WindowInfo | null = null;
  let byTitle = false;
  if (!target) {
    const needle = String(arg.app ?? "").trim().toLowerCase();
    if (!needle) return { ok: false, error: "Give a pid or an app name." };
    const list = await listWindows();
    if (!list.ok) return { ok: false, error: list.error };
    const windows = list.windows ?? [];
    // One matcher for every caller — see matchWindow(). This used to be three
    // inline `.includes()` checks here and a name-only check in launchApp(),
    // which is how the two disagreed about whether an app was open.
    const hit = matchWindowDetailed(windows, needle);
    matched = hit.window;
    byTitle = hit.by === "title";
    if (!matched) {
      return { ok: false, error: `No open window matches ${JSON.stringify(arg.app)}.`, open: windows.map((w) => w.name) };
    }
    target = matched.pid;
  }

  const r = await run(focusScript(Number(target)));
  if (!r.ok) return { ok: false, error: r.error };
  try {
    const out = JSON.parse((r.stdout ?? "").trim());
    return {
      ok: !!out.ok,
      pid: out.pid,
      title: out.title,
      matched: matched?.name ?? null,
      ...(byTitle ? { matchedByTitle: true } : {}),
      ...(out.elevated ? { elevated: true } : {}),
    };
  } catch {
    return { ok: false, error: "focus call returned nothing parseable" };
  }
}

/**
 * Start an application, and hand it arguments.
 *
 * This exists because focus_window could only raise a window that was ALREADY
 * open, so "open Chrome and go to google.com" had no hands-free path at all: the
 * agent fell back to alt-tabbing and typing into the address bar, which lands in
 * whatever Windows has in front and needs a human to rescue it. Launching with
 * the URL as an argument is one call, needs no focus and no synthetic keystrokes,
 * and is the reliable way to do the thing that was being attempted.
 *
 * Start-Process on an app that is already running starts a SECOND copy (the
 * system prompt warns about exactly this), so an already-open app is focused
 * instead — except when arguments are given, where a URL handed to a running
 * browser opens a tab in it rather than a second browser.
 */
export async function launchApp(app: string, argstr?: string): Promise<{
  ok: boolean; launched?: boolean; focused?: boolean; pid?: number; title?: string; error?: string;
}> {
  if (process.platform !== "win32") return { ok: false, error: "Windows only." };
  const name = String(app ?? "").trim();
  if (!name) return { ok: false, error: "Give an app to launch." };
  const extra = String(argstr ?? "").trim();

  // Already open and nothing to pass: raise it rather than starting a second one.
  if (!extra) {
    const list = await listWindows();
    const open = matchWindow(list.windows ?? [], name);
    if (open) {
      const f = await focusWindow({ pid: open.pid });
      return { ok: f.ok, launched: false, focused: f.ok, pid: f.pid, title: f.title, error: f.ok ? undefined : f.error };
    }
  }

  // Resolve the name BEFORE launching, and refuse if it does not resolve.
  //
  // `Start-Process <name>` on an unresolvable name does not simply fail. Windows
  // hands it to the shell, which puts a "How do you want to open this file?"
  // chooser or the Settings > Default apps page in front of the USER and waits.
  // Nothing throws, so the launch reports success; no window with that name ever
  // appears, so the poll below times out; and meanwhile the user is looking at a
  // modal they did not ask for. Observed exactly this way — and because a modal
  // dialog is not a process MAIN window, listWindows() cannot even see it, so
  // the agent is told "nothing happened" while the screen says otherwise.
  //
  // Get-Command covers aliases, functions, .exe on PATH and app-execution
  // aliases, which is the same set Start-Process would accept without prompting.
  // An absolute path is checked as a path.
  // Three ways an app can be named, tried in order of certainty:
  //
  //   1. a real path                      "C:\Apps\thing.exe"
  //   2. something on PATH                "notepad", "code"
  //   3. its Start Menu display name      "MSI Afterburner", "Google Chrome"
  //
  // (3) is the one people actually say out loud, and it was missing entirely.
  // `MSIAfterburner` is not on PATH and no executable is called "MSI
  // Afterburner", so "open MSI Afterburner" could never work — while a shortcut
  // named exactly that sits in the Start Menu, which is where the user clicks
  // it from. Matching folds punctuation and spacing (see fold()), so "msi
  // afterburner", "MSIAfterburner" and "MSI Afterburner" all land on it.
  //
  // A .lnk is handed to Start-Process directly: Windows resolves the target,
  // working directory and any arguments baked into the shortcut, which is more
  // faithful than digging the target .exe out and running it bare.
  const resolveScript =
    `$n = ${psQuote(name)}\n` +
    `$fold = { param($s) ($s -replace '\\.exe$','' -replace '[^A-Za-z0-9]','').ToLower() }\n` +
    `$want = & $fold $n\n` +
    `if (Test-Path -LiteralPath $n) { ConvertTo-Json -Compress @{ ok = $true; path = (Resolve-Path -LiteralPath $n).Path; how = 'path' } }\n` +
    `else {\n` +
    `  $c = Get-Command $n -ErrorAction SilentlyContinue | Select-Object -First 1\n` +
    `  if ($c) { ConvertTo-Json -Compress @{ ok = $true; path = $(if ($c.Source) { $c.Source } else { $n }); how = 'path' } }\n` +
    `  else {\n` +
    `    $roots = @("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs")\n` +
    `    $lnks = foreach ($r in $roots) { if (Test-Path $r) { Get-ChildItem -Path $r -Filter *.lnk -Recurse -ErrorAction SilentlyContinue } }\n` +
    // Exact fold first, then prefix, then contains — the same precedence the
    // window matcher uses, so "chrome" prefers "Chrome" over "Chrome Canary".
    `    $hit = $lnks | Where-Object { (& $fold $_.BaseName) -eq $want } | Select-Object -First 1\n` +
    `    if (-not $hit) { $hit = $lnks | Where-Object { (& $fold $_.BaseName).StartsWith($want) } | Sort-Object { $_.BaseName.Length } | Select-Object -First 1 }\n` +
    `    if (-not $hit) { $hit = $lnks | Where-Object { (& $fold $_.BaseName).Contains($want) } | Sort-Object { $_.BaseName.Length } | Select-Object -First 1 }\n` +
    `    if ($hit) { ConvertTo-Json -Compress @{ ok = $true; path = $hit.FullName; how = 'startmenu'; label = $hit.BaseName } }\n` +
    `    else { ConvertTo-Json -Compress @{ ok = $false } }\n` +
    `  }\n` +
    `}`;
  const res = await run(resolveScript);
  let resolved: string | null = null;
  try {
    const out = JSON.parse((res.stdout ?? "").trim());
    if (out.ok) resolved = String(out.path ?? name);
  } catch {
    /* fall through to the guard below */
  }
  if (!resolved) {
    return {
      ok: false,
      error:
        `could not find an application called ${JSON.stringify(name)} on this machine. ` +
        "Nothing was launched — Windows would have shown the user an \"open with\" chooser instead. " +
        'Use focus_window(action="list") to see what is already open, or give the full path to the .exe.',
    };
  }

  // Start-Process's own failure has to be caught and reported. Without the
  // try/catch this script printed `ok = $true` unconditionally on the next line,
  // so a name PowerShell could not resolve at all still came back as a
  // successful launch — and the only symptom was a window that never appeared,
  // which reads identically to a slow app.
  // What was already on screen, so a launch that produces SOMETHING ELSE — a
  // chooser, an installer, an error dialog, a Store page — can name it instead
  // of reporting a silent nothing.
  const before = new Set(((await listWindows()).windows ?? []).map((w) => `${w.pid}`));

  // Launch what was RESOLVED, not the raw words. Handing Start-Process the
  // user's phrasing is what let an unresolvable name reach the shell and put an
  // "open with" chooser in front of the user.
  const spawn = extra
    ? `Start-Process -FilePath ${psQuote(resolved)} -ArgumentList ${psQuote(extra)} -ErrorAction Stop`
    : `Start-Process -FilePath ${psQuote(resolved)} -ErrorAction Stop`;
  const script =
    `try { ${spawn}; ConvertTo-Json -Compress @{ ok = $true } }\n` +
    `catch { ConvertTo-Json -Compress @{ ok = $false; error = $_.Exception.Message } }`;
  const r = await run(script);
  if (!r.ok) return { ok: false, error: r.error };
  try {
    const out = JSON.parse((r.stdout ?? "").trim());
    if (!out.ok) {
      return { ok: false, error: `could not start ${name}: ${out.error ?? "unknown error"}` };
    }
  } catch {
    /* unparseable output is not itself a failure — fall through to the poll */
  }

  // Give the window time to exist before claiming anything about it. A launch
  // that reports success before the app has drawn is the kind of "worked" that
  // leaves the next tool call typing into the wrong place.
  //
  // The budget used to be 12 x 400ms. Five seconds is fine for Notepad and far
  // too short for anything real: a hardware utility, an IDE, an Electron app or
  // any first-ever launch routinely takes 10-30s, and an app that needed a UAC
  // prompt has not even started until someone answers it. Polling is cheap
  // (one PowerShell call), the loop exits the moment the window appears, and
  // the cost of being wrong is the model concluding the launch failed and
  // going hunting for the app by pixel.
  const deadline = Date.now() + LAUNCH_WAIT_MS;
  const appeared = new Map<string, WindowInfo>();
  let waited = 0;
  while (Date.now() < deadline) {
    // Back off as it goes: fast enough to feel instant for a light app, patient
    // enough not to spend 60 PowerShell calls waiting for a heavy one.
    const gap = waited < 4000 ? 300 : waited < 12000 ? 750 : 1500;
    await new Promise((res) => setTimeout(res, gap));
    waited += gap;
    const list = await listWindows();
    const w = matchWindow(list.windows ?? [], name);
    if (w) {
      const f = await focusWindow({ pid: w.pid });
      return { ok: true, launched: true, focused: f.ok, pid: w.pid, title: w.title };
    }
    for (const x of list.windows ?? []) if (!before.has(`${x.pid}`)) appeared.set(`${x.pid}`, x);
  }
  // It started but never showed a window. Say so rather than implying it is
  // ready, and say what to do about it — this message is the model's only
  // information, and the previous wording sent it looking for the app on screen.
  // Name whatever DID show up. A launch that opens a chooser, a Store page or an
  // error dialog instead of the app is the common case here, and "no window
  // appeared" describes it so badly that the model concludes nothing happened
  // and starts clicking around looking for the app.
  const others = [...appeared.values()].map((w) => `${w.name} ("${w.title}")`);
  const insteadNote = others.length
    ? ` These windows opened instead: ${others.slice(0, 4).join(", ")} — the launch probably produced one of those rather than ${name}, and it may be waiting on YOU.`
    : "";
  return {
    ok: true,
    launched: true,
    focused: false,
    error:
      `${name} was started but no window of its own appeared within ${Math.round(LAUNCH_WAIT_MS / 1000)}s.${insteadNote} ` +
      "It may still be loading, may have opened to the system tray, or may be waiting on a UAC or \"open with\" prompt " +
      "that this tool cannot see (dialogs are not process main windows). " +
      'Check with focus_window(action="list"), or ask the user what is on screen — do NOT go looking for it by clicking.',
  };
}

/** How long to wait for a launched app's window. See the note in launchApp(). */
const LAUNCH_WAIT_MS = 30_000;

/** Single-quote a string for PowerShell (doubling any embedded quote). */
function psQuote(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** The agent-facing tool. */
export async function runFocusWindow(args: FocusWindowArgs, _signal?: AbortSignal, _ctx?: ToolContext): Promise<ToolResult> {
  if (args.action === "launch") {
    const r = await launchApp(args.app ?? "", args.args);
    if (!r.ok) return { output: `focus_window: ${r.error}`, isError: true };
    // Report focus honestly: "started" and "in front and ready for input" are
    // different claims, and conflating them is what made a silent failure look
    // like a success.
    const what = r.launched ? "Launched" : "Already running — focused";
    const ready = r.focused
      ? "It is in the foreground now."
      : `WARNING: it is NOT in the foreground${r.error ? ` (${r.error})` : ""} — do not send keystrokes expecting them to land there.`;
    return { output: `${what} ${args.app}${args.args ? ` with ${args.args}` : ""}. ${ready}`, isError: false };
  }

  if (args.action === "list") {
    const r = await listWindows();
    if (!r.ok) return { output: `focus_window: ${r.error}`, isError: true };
    const rows = (r.windows ?? []).map((w) => `${w.pid}\t${w.name}\t${w.title}`);
    return { output: rows.length ? `pid\tprocess\ttitle\n${rows.join("\n")}` : "No windows are open.", isError: false };
  }

  const r = await focusWindow({ app: args.app, pid: args.pid });
  if (!r.ok) {
    // An elevated target is a security boundary, not a retryable failure.
    // Windows will not let a normal process raise an administrator window, and
    // no choice of API changes that. Saying so plainly is what stops the model
    // trying three more ways and then clicking around the screen hunting for a
    // window it can never bring forward.
    if (r.elevated) {
      return {
        output:
          `focus_window: "${String(r.title ?? args.app).trim()}" (pid ${r.pid}) is running as ADMINISTRATOR and ` +
          "Gnosis is not, so Windows will not allow it to be brought to the front. This cannot be worked around " +
          "from here and retrying will not help. The window IS open — ask the user to click it, or to restart " +
          "Gnosis as administrator if this needs to be automated. Do NOT send keystrokes: they would land in " +
          "whatever is actually in front.",
        isError: true,
      };
    }
    const hint = r.open?.length ? `\nOpen now: ${[...new Set(r.open)].join(", ")}` : "";
    return { output: `focus_window: ${r.error}${hint}`, isError: true };
  }
  // Windows takes a moment to actually move the foreground after AppActivate
  // returns. Sending keystrokes on the next line lands them in whatever was in
  // front before — which is the "focus worked but typing went elsewhere" report.
  await new Promise((res) => setTimeout(res, 350));
  // A title match is a guess — say so. Asking for "notepad" on a machine where
  // VS Code has a file called `notepad` open matches VS Code, and the next
  // keystrokes would go into the user's editor. Naming the window that was
  // actually raised is what lets the model catch that before it types.
  const caveat = r.matchedByTitle
    ? ` NOTE: matched on the WINDOW TITLE, not the process name — check this is the window you meant before typing.`
    : "";
  return {
    output: `Focused ${r.matched ?? r.pid} — "${r.title}". It is in the foreground and settled; keystrokes will land there.${caveat}`,
    isError: false,
  };
}

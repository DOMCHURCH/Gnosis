// Verify (focus_window): opening and raising apps, and failing honestly.
//
// Hermetic on purpose — nothing here launches an app or moves a window. The live
// behaviour was checked by hand on Windows against the real failure ("open MSI
// Afterburner"); what is pinned here is the pure matching logic and the
// structural decisions in the source, which is what actually regressed.
//
// The original failure had four separate causes stacked on top of each other,
// and each one is a section below:
//
//   1. "MSI Afterburner" was not resolvable at all — not on PATH, and no
//      executable has that name. Start-Process handed it to the shell, which put
//      an "open with" chooser in front of the USER and waited. Nothing threw, so
//      the launch reported success.
//   2. Nothing looked in the Start Menu, which is where the app the user means
//      actually lives, under exactly the name they say.
//   3. The window poll matched process names with a raw substring test, so even
//      when an app did start, "msi afterburner" never matched "MSIAfterburner".
//   4. The wait was 5s. Measured on real hardware: MSI Afterburner takes ~9s and
//      Notepad up to ~11s from cold.
//
// The model's response to all of this was to conclude nothing had happened and
// start clicking at guessed coordinates.
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const imp = (f) => import(pathToFileURL(path.resolve(here, f)).href);

const { matchWindow, matchWindowDetailed } = await imp("../dist/tools/focuswindow.js");

let fails = 0;
const ok = (n, c, extra = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${extra ? ` — ${extra}` : ""}`); if (!c) fails++; };

const W = (name, title, pid = 1) => ({ pid, name, title });

// --- 1. the name people say vs the name Windows uses -------------------------
{
  const wins = [W("MSIAfterburner", "MSI Afterburner ", 10), W("Code", "x - Visual Studio Code", 11), W("chrome", "Google Chrome", 12)];
  ok("'MSI Afterburner' finds MSIAfterburner", matchWindow(wins, "MSI Afterburner")?.pid === 10);
  ok("...and so does the run-together spelling", matchWindow(wins, "msiafterburner")?.pid === 10);
  ok("...and the .exe form", matchWindow(wins, "MSIAfterburner.exe")?.pid === 10);
  ok("...matched on the PROCESS NAME, so it is trustworthy",
    matchWindowDetailed(wins, "MSI Afterburner").by === "name");
  ok("case and spacing do not matter", matchWindow(wins, "  mSi   aFTERburner ")?.pid === 10);
  ok("an unrelated name matches nothing", matchWindow(wins, "photoshop") === null);
  ok("an empty name matches nothing", matchWindow(wins, "") === null && matchWindow(wins, "   ") === null);
}

// --- 2. a process-name hit must beat a title hit -----------------------------
// Real case from the dev machine: VS Code had a file called `notepad` open, so
// its title was "notepad - Untitled (Workspace) - Visual Studio Code". Asking
// for notepad matched VS CODE. Focusing the wrong window is the exact failure
// this module exists to prevent, because the keystrokes that follow go
// somewhere real.
{
  const wins = [W("Code", "notepad - Untitled (Workspace) - Visual Studio Code", 20), W("Notepad", "Untitled - Notepad", 21)];
  ok("the real Notepad wins over an editor with 'notepad' in its title",
    matchWindow(wins, "notepad")?.pid === 21);
  ok("...by name, not by title", matchWindowDetailed(wins, "notepad").by === "name");

  // With the real one gone, a title match is allowed — but must be LABELLED, so
  // the caller can say which window it actually raised.
  const only = [W("Code", "notepad - Untitled (Workspace) - Visual Studio Code", 20)];
  const hit = matchWindowDetailed(only, "notepad");
  ok("a title-only match still resolves", hit.window?.pid === 20);
  ok("...but is flagged as a guess", hit.by === "title");
}

// --- 3. resolve before launching ---------------------------------------------
{
  const src = readFileSync(path.join(root, "src", "tools", "focuswindow.ts"), "utf8");
  ok("the app name is resolved before Start-Process runs", /Get-Command \$n -ErrorAction SilentlyContinue/.test(src));
  ok("...an absolute path is honoured", /Test-Path -LiteralPath \$n/.test(src));
  ok("...and the Start Menu is searched for a display name", /Start Menu\\\\Programs/.test(src));
  ok("...matching shortcuts by the same folded comparison", /\$fold = \{ param\(\$s\)/.test(src));
  // The whole point: an unresolvable name must be REFUSED, not handed to the
  // shell to ask the user about.
  ok("an unresolvable name is refused, not launched", /could not find an application called/.test(src));
  ok("...and says why, naming the chooser it avoided", /open with. chooser/.test(src));
  // And what does get launched is the resolved target.
  const spawnIdx = src.indexOf("const spawn = extra");
  ok("Start-Process is given the RESOLVED path, not the raw words",
    spawnIdx !== -1 && /psQuote\(resolved\)/.test(src.slice(spawnIdx, spawnIdx + 400)));
  ok("Start-Process failures are caught rather than assumed away",
    /-ErrorAction Stop/.test(src) && /catch \{ ConvertTo-Json -Compress @\{ ok = \$false/.test(src));
}

// --- 4. wait long enough for a real application ------------------------------
{
  const src = readFileSync(path.join(root, "src", "tools", "focuswindow.ts"), "utf8");
  const ms = Number(/const LAUNCH_WAIT_MS = ([\d_]+)/.exec(src)?.[1]?.replace(/_/g, "") ?? 0);
  // Measured on real hardware: Afterburner ~9s, Notepad up to ~11s cold. 5s (the
  // old budget) fails both.
  ok("the launch wait is long enough for a real app", ms >= 20_000, `${ms}ms`);
  ok("...but not unbounded", ms <= 60_000, `${ms}ms`);
  ok("the poll backs off instead of hammering PowerShell", /waited < 4000 \? 300/.test(src));
  ok("...and exits as soon as the window appears", /if \(w\) \{[\s\S]{0,200}return \{ ok: true, launched: true/.test(src));
}

// --- 5. tell the truth when it does not work ---------------------------------
{
  const src = readFileSync(path.join(root, "src", "tools", "focuswindow.ts"), "utf8");
  // Windows that appeared INSTEAD are named. "no window appeared" describes a
  // chooser or a Store page so badly that the model concludes nothing happened.
  ok("windows that opened instead are reported", /These windows opened instead/.test(src));
  ok("...and the tool admits it cannot see dialogs", /dialogs are not process main windows/.test(src));
  // An elevated target is a boundary, not a retryable failure.
  ok("an elevated target is detected", /\$elevated = \[string\]::IsNullOrEmpty\(\$p\.Path\)/.test(src));
  ok("...and reported as unfixable rather than retried", /retrying will not help/.test(src));
  ok("...telling the user what to actually do", /ask the user to click it/.test(src));
  // A title-based focus says so, so a wrong window is visible before typing.
  ok("a title-matched focus warns before keystrokes", /matched on the WINDOW TITLE/.test(src));
  // And in every failure case, the model is told not to go clicking.
  ok("failures steer away from blind clicking", /do NOT go looking for it by clicking/.test(src));
}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

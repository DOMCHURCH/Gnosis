// Verify (web UI): you can always get out.
//
// Three ways the shell trapped you, all reported from real use:
//
//  1. The file/note preview ran the FULL viewport height (`align="stretch"`,
//     `height: 100%`). In the desktop shell the title bar is a fixed, frameless
//     strip painted over the page, so the preview's own header — the one holding
//     ✕ — sat underneath it and could not be clicked. Escape worked, but nothing
//     said so. "I also cant access the exit button."
//
//  2. The window controls were three 13px coloured circles — macOS traffic
//     lights on Windows — and the `label` they were handed was never rendered.
//     Three unlabelled dots in the corner of a Windows app is not a style, it is
//     a control nobody can read.
//
//  3. Files opened expanded. With the 340px section cap gone (s92), a real
//     project's tree is hundreds of rows, so the entire Workspace tier sat below
//     the fold.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "src");
const read = (f) => readFileSync(path.join(web, f), "utf8");
const top = read("TopBar.tsx");
const clay = read("clay.css");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- 1. previews are bounded, and their close button is reachable -------------
for (const f of ["FileBrowser.tsx", "ObsidianPanel.tsx"]) {
  const src = read(f);
  // Matched as real JSX/style, not as the prose in the comment explaining why
  // it is gone — the explanation quotes the old code by name on purpose.
  ok(`${f}'s preview is not full-height`,
    !/<Overlay[^>]*align="stretch"/.test(src) && !/^\s*(?!\/\/).*height: "100%"/m.test(src));
  ok(`${f}'s preview is bounded to the viewport`, /height: "min\(760px, 86vh\)"/.test(src));
  ok(`${f}'s preview is narrower than the screen`, /width: "min\(\d+px, 92vw\)"/.test(src));
  // A 14px glyph with 4px of padding is not a target you can hit twice in a row.
  ok(`${f}'s close button is a real target`, /width: 34, height: 32/.test(src));
  ok(`${f} says Escape also works`, /title="close \(Esc\)"/.test(src));
  ok(`${f} labels it for a screen reader`, /aria-label="Close /.test(src));
}
// The belt to those braces: no overlay, present or future, may occupy the strip
// the fixed title bar owns.
ok("overlays are held clear of the shell title bar",
  /\.gnosis-shell \[data-testid="overlay-backdrop"\] \{[\s\S]*?padding-top: 72px !important;/.test(clay));

// --- 2. Windows window controls ------------------------------------------------
ok("the controls are not macOS traffic lights",
  !/borderRadius: "50%"/.test(top) && !/width: 13,\s*height: 13,/.test(top));
ok("...they are Windows-shaped", /width: 44,\s*height: 32,/.test(top) && /borderRadius: 0,/.test(top));
// The old component took a `label` and never rendered it. That is the actual bug.
ok("...and the glyph is actually rendered", /\{props\.label\}/.test(top));
for (const [what, glyph] of [["minimise", "&#x2500;"], ["close", "&#x2715;"]]) {
  ok(`the ${what} glyph is present`, top.includes(glyph));
}
ok("maximise reflects its own state", /label=\{maximized \? "❐" : "☐"\}/.test(top));
ok("close goes red, like every other Windows app", /#C42B1C/.test(top));
ok("...and only close does", (top.match(/danger/g) ?? []).length >= 2 && /danger onClick=\{\(\) => props\.shell\.close\(\)\}/.test(top));
ok("the controls sit flush in the corner", /data-testid="window-controls"/.test(top) && /marginRight: -14/.test(top));
// They must stay outside the drag region or they move the window instead.
ok("...outside the drag region", /WebkitAppRegion: "no-drag"/.test(top));
// The rest of the bar is unchanged — the user asked for the access points to
// stay put, so the gear and the readouts must still be here and still be left of
// the controls.
{
  const gear = top.indexOf('title="Settings"');
  const controls = top.indexOf('data-testid="window-controls"');
  ok("settings is still in the bar", gear !== -1);
  ok("...and still left of the window controls", gear < controls);
  ok("the session/cost readouts are still in the bar",
    /data-testid="cost-badge"/.test(top) && /props\.globalLine/.test(top));
}

// --- 3. Files starts collapsed --------------------------------------------------
const side = read("Sidebar.tsx");
ok("Files is closed by default", /useState<Record<string, boolean>>\(\{ project: true \}\)/.test(side));
ok("...but the project is still open", /\{ project: true \}/.test(side));
ok("...and the reason is recorded", /Workspace tier below the fold/.test(side));

console.log(fails ? `\n${fails} FAILED` : "\nall window-chrome checks passed");
process.exit(fails ? 1 : 0);

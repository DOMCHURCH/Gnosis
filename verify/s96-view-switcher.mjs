// Verify (web UI): the view switcher is always there, and ✕ actually quits.
//
// The switcher was two separate instances and both could vanish:
//
//   - a fixed copy for the kanban view at `top: 10, right: 14`, z-index `chrome`
//     (30). The desktop shell's frameless title bar is at z 55 and occupies that
//     exact strip, so on kanban the switcher was drawn underneath it — invisible
//     and unclickable;
//   - a docked copy rendered INSIDE the floor column, which the terminal dock
//     (z 40, bottom-anchored, resizable to 700px) covered as soon as you opened
//     the terminal.
//
// Either way there was no control left that could change the view. "I cant go
// back and I am stuck then have to close the app." And closing the app did not
// close it either — ✕ hid to the tray, so the button that looks exactly like
// every Windows close button closed nothing.
//
// The rule now: ONE switcher, always rendered, above everything that could cover
// it, with every destination on it at all times.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "web", "src");
const read = (f) => readFileSync(path.join(web, f), "utf8");
const app = read("app.tsx");
const layers = read("layers.ts");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- one switcher, not two ------------------------------------------------------
ok("there is no docked/floating pair any more", !/makeViewToggle/.test(app));
ok("...just one instance", (app.match(/data-testid="view-toggle"/g) ?? []).length === 1);
// A copy that lives inside a view disappears with that view. It must be a
// sibling of the view, not a child of it.
ok("it is not handed to SessionsFloor to render", /viewTabs=\{null\}/.test(app));
// ...and it is rendered on BOTH branches, or one view is still stranded. There
// are exactly two returns that render a view — the kanban early-return and the
// floor fallthrough — so two render sites means both are covered.
{
  const sites = (app.match(/\{viewToggle\}/g) ?? []).length;
  ok("rendered on both view branches", sites === 2);
  if (sites !== 2) console.log(`     found ${sites} render sites; expected one per view`);
  // Guard the assumption above: if a third view is ever added, this fails and
  // whoever adds it has to render the switcher there too.
  ok("...and there are still only two views", /useState<"floor" \| "kanban">\("floor"\)/.test(app));
}

// --- nothing may cover it -------------------------------------------------------
ok("it has its own layer", /viewToggle: 48,/.test(layers));
{
  const val = (n) => Number(layers.match(new RegExp(`\\b${n}: (\\d+),`))[1]);
  ok("...above the terminal dock", val("viewToggle") > val("dock"));
  ok("...above the detached chat", val("viewToggle") > val("float"));
  // Below modals on purpose: a modal is meant to be answered, and every modal
  // can now be closed (s95).
  ok("...but below modals", val("viewToggle") < val("overlay"));
  ok("the title bar is still above modals", val("titleBar") > val("overlay"));
}
ok("it uses that layer", /zIndex: Z\.viewToggle/.test(app));
// The other half of the kanban bug: y=10 is inside the shell's title bar.
ok("it clears the shell title bar", /top: shell \? 66 : 10/.test(app));
ok("...and the page reserves that band",
  /\.gnosis-shell \[data-testid="page-root"\] \{[\s\S]*?padding-top: 100px !important;/.test(read("clay.css")));
for (const f of ["SessionsFloor.tsx", "KanbanBoard.tsx"]) {
  ok(`${f} tags its page root so the band applies`, /data-testid="page-root"/.test(read(f)));
}

// --- every destination is on it, always -----------------------------------------
for (const chip of ["FLOOR", "KANBAN", "◆ SERVE", "▸_ TERMINAL"]) {
  ok(`${chip} is on the switcher`, app.includes(`chip("${chip}"`));
}
// TERMINAL used to be gated on `view === "floor"`, so from kanban you could
// neither open the terminal nor — once in it — close it.
ok("TERMINAL is not gated on the current view", !/view === "floor" && !isMobile && chip\("▸_ TERMINAL"/.test(app));

// --- the terminal cannot bury the page ------------------------------------------
// A flat 700px cap is only a cap on a tall window.
const term = read("Terminal.tsx");
ok("the dock is capped against the window, not a constant", /window\.innerHeight - 180/.test(term));
ok("...and the old flat cap is gone", !/Math\.min\(700,/.test(term));

// --- ✕ quits --------------------------------------------------------------------
const main = readFileSync(path.join(root, "electron", "main.js"), "utf8");
ok("win:close quits the app", /on\("win:close", \(\) => app\.quit\(\)\);/.test(main));
ok("...it no longer just hides the window", !/on\("win:close", \(w\) => w\.close\(\)\)/.test(main));
// before-quit sets `quitting`, which is what lets the close handler through
// instead of preventDefault-ing back to a hidden window.
ok("the hide-on-close guard still yields to a real quit", /if \(quitting\) return;\s*e\.preventDefault\(\);/.test(main));
ok("the button says what it does now", /title="Close Gnosis"/.test(read("TopBar.tsx")));
// Hiding to the tray is still the right thing for a background agent — it just
// has to be asked for rather than done to you.
const tray = readFileSync(path.join(root, "electron", "tray.js"), "utf8");
ok("hide-to-tray is still available, from the tray", /label: "Hide to tray"/.test(tray));
ok("...and wired to a real handler", /onHide\?\.\(\)/.test(tray) && /onHide: \(\) => \{ if \(win/.test(main));

console.log(fails ? `\n${fails} FAILED` : "\nall view-switcher checks passed");
process.exit(fails ? 1 : 0);

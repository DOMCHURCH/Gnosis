// Verify (web UI): full-screen overlays are portalled out of the panels.
//
// This has a history. The file and note previews rendered a `position: fixed;
// inset: 0` backdrop from INSIDE the left panel — which is correct CSS and was
// never the bug. The bug is that `fixed` stops meaning "the viewport" the moment
// any ancestor has a transform, filter, backdrop-filter, perspective, contain or
// will-change: the element is then positioned against, and clipped to, that
// ancestor. The panel had grown a `transform: translateY(-2px)` hover lift, and
// you are by definition hovering the panel when you click a file inside it — so
// the backdrop covered only the 264px sidebar while the modal's content spilled
// across the floor and the chat with nothing behind it.
//
// It was "fixed" twice by adjusting the modal's own background and z-index, and
// neither could land. Hence this: the rule is not "the overlay has the right
// colours", it is "the overlay is not inside a panel at all".
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "src");
const read = (f) => readFileSync(path.join(web, f), "utf8");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- the shared overlay -------------------------------------------------------
const overlay = read("Overlay.tsx");
ok("Overlay portals to document.body", /createPortal\([\s\S]*document\.body/.test(overlay));
ok("...covers the viewport", /position: "fixed"[\s\S]*inset: 0/.test(overlay));
ok("...with an opaque backdrop", /rgba\(6, 6, 10, 0\.86\)/.test(overlay));
ok("...and is identifiable from a test", /data-testid="overlay-backdrop"/.test(overlay));

// --- every preview uses it ----------------------------------------------------
for (const f of ["FileBrowser.tsx", "ObsidianPanel.tsx", "FileOutput.tsx"]) {
  const src = read(f);
  ok(`${f} renders its overlay through Overlay`, /<Overlay[\s>]/.test(src));
  // The tell-tale of a hand-rolled one that would break again.
  ok(`${f} has no hand-rolled fixed backdrop left`,
    !/position: "fixed", inset: 0, background:/.test(src));
}

// --- nothing else may hand-roll one -------------------------------------------
// A new full-screen overlay written inline inside a panel is the same bug again.
// SessionsFloor's remaining ones are MOBILE BOTTOM SHEETS rendered at the page
// root, not inside a panel — they slide up from the bottom edge rather than
// dimming a centred modal, and nothing above them establishes a containing
// block. Listed explicitly so the exemption is a decision, not an oversight.
const ALLOWED = new Set(["SessionsFloor.tsx"]);
const offenders = [];
for (const f of readdirSync(web).filter((x) => x.endsWith(".tsx") && x !== "Overlay.tsx" && !ALLOWED.has(x))) {
  const src = read(f);
  // `inset: 0` + a background, i.e. a backdrop, without going through Overlay.
  if (/position: "fixed",\s*inset: 0,\s*background:/.test(src)) offenders.push(f);
}
ok("no component hand-rolls a full-screen backdrop", offenders.length === 0);
if (offenders.length) console.log(`     ${offenders.join(", ")} — use <Overlay> instead`);

// --- the ancestor that caused it ----------------------------------------------
// The hover lift is fine and stays; this records WHY the portal is required, so
// nobody removes the portal thinking the transform is the thing to delete.
const clay = readFileSync(path.join(web, "clay.css"), "utf8");
ok("the panel hover transform still exists (the reason the portal is needed)",
  /\[data-testid="left-panel"\]:hover \{[\s\S]*?transform: translateY/.test(clay));

console.log(fails ? `\n${fails} FAILED` : "\nall overlay-portal checks passed");
process.exit(fails ? 1 : 0);

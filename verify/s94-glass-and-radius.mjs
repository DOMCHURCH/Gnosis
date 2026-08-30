// Verify (web UI): one glass rule, one radius scale, and no token collisions.
//
// The look was mixed rather than decided. Glass appeared on the top bar and the
// voice overlay while everything else was opaque clay, so it read as unresolved
// instead of as a style; and a measurement of the running page found five
// different corner radii, with 21 bordered surfaces sitting square inside panels
// rounded to 18px.
//
// Two rules now, and this suite is what keeps them rules:
//
//   GLASS is for the FLOATING tier — things that sit above other content: the
//   top bar, modal backdrops, the drag overlay, the voice overlay. Content
//   surfaces stay clay. The floor is the case that matters: it is a live WebGL
//   canvas, so anything glassy over it re-resolves its blur every frame, and
//   what it blurs is the scene you were trying to read.
//
//   RADIUS has four steps, each owning a job: 18 panel, 14 card, 10 control,
//   4 tag. Bigger surface, rounder corner.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "web", "src");
const read = (f) => readFileSync(path.join(web, f), "utf8");
const clay = read("clay.css");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- the token collision -------------------------------------------------------
// `--clay-inset` was declared twice in :root — once as a colour (#101017) and
// once as a 16px length. The length came second, so it won, and the colour had
// been silently dead ever since. Two names now, one meaning each.
{
  const rootBlock = clay.slice(clay.indexOf(":root {"), clay.indexOf("\n}", clay.indexOf(":root {")));
  const names = [...rootBlock.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  ok("no custom property is declared twice in :root", dupes.length === 0);
  if (dupes.length) console.log(`     duplicated: ${[...new Set(dupes)].join(", ")}`);
}
ok("the colour and the length have separate names",
  /--clay-surface-inset: #101017;/.test(clay) && /--clay-gap: 16px;/.test(clay));
ok("the old ambiguous name is gone", !/^\s*--clay-inset\s*:/m.test(clay));
ok("...and nothing still refers to it", !/var\(--clay-inset\)/.test(clay));

// --- the radius scale ----------------------------------------------------------
const STEPS = { "--clay-r-panel": "18px", "--clay-r-card": "14px", "--clay-r-ctl": "10px", "--clay-r-tag": "4px" };
for (const [tok, val] of Object.entries(STEPS)) {
  ok(`${tok} is ${val}`, new RegExp(`${tok}: ${val};`).test(clay));
}
// Four steps, not five. An extra token is how a scale stops being a scale.
{
  const radiusTokens = [...clay.matchAll(/^\s*(--clay-r-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]);
  ok("there are exactly four radius tokens", radiusTokens.length === 4);
  if (radiusTokens.length !== 4) console.log(`     found: ${radiusTokens.join(", ")}`);
}
// The old names must be fully migrated, or half the sheet silently falls back to
// 0 (an undefined var in `border-radius: var(--clay-r)` makes the whole
// declaration invalid).
for (const old of ["--clay-r\\)", "--clay-r-sm", "--clay-r-xs"]) {
  ok(`the old token ${old.replace("\\)", "")} is gone`, !new RegExp(`var\\(${old}`).test(clay));
}
// Every var(--clay-r-*) must name a token that exists.
{
  const used = new Set([...clay.matchAll(/var\((--clay-r-[a-z]+)\)/g)].map((m) => m[1]));
  const undef = [...used].filter((u) => !(u in STEPS));
  ok("every radius var used resolves to a declared token", undef.length === 0);
  if (undef.length) console.log(`     undeclared: ${undef.join(", ")}`);
}

// --- the glass rule ------------------------------------------------------------
ok("glass has tokens rather than being retyped per site",
  /--clay-glass: blur\(14px\)/.test(clay) && /--clay-glass-thin: blur\(3px\)/.test(clay));

// Content surfaces are forced clay, so a call site cannot reintroduce glass
// inline over the floor. Verified live too (see below) — this checks the rule
// exists at all.
const CONTENT = ["left-panel", "right-panel", "floor-container", "three-floor",
                 "agent-inspector", "chat-drop", "session-title", "activity-strip"];
const rule = clay.slice(clay.indexOf("the glass rule"));
for (const t of CONTENT) {
  ok(`${t} is held to clay`, rule.includes(`[data-testid="${t}"]`));
}
ok("...by an explicit backdrop-filter: none", /backdrop-filter: none !important;/.test(rule));
ok("the top bar is still glass (it is floating chrome)",
  /\[data-testid="top-bar"\] \{[\s\S]*?backdrop-filter: var\(--clay-glass\);/.test(clay));

// Every backdrop-filter in the web UI must belong to the floating tier. A new one
// on a content component is the mix coming back.
const FLOATING = new Set([
  "Overlay.tsx",      // the shared modal backdrop
  "OverlayModal.tsx", // the command/model picker's own backdrop
  "DropZone.tsx",     // the drag-and-drop overlay
  "clay.css",         // the top bar + the none-rule above
]);
const offenders = [];
for (const f of readdirSync(web).filter((x) => /\.(tsx|ts|css)$/.test(x))) {
  if (FLOATING.has(f)) continue;
  if (/backdrop-?[Ff]ilter/.test(read(f))) offenders.push(f);
}
ok("no content component uses glass", offenders.length === 0);
if (offenders.length) console.log(`     ${offenders.join(", ")} — glass is for the floating tier only`);

// The two modal implementations must agree on what a dimmed page looks like.
{
  const a = read("Overlay.tsx"), b = read("OverlayModal.tsx");
  ok("both modal backdrops use the same dim", /rgba\(6, 6, 10, 0\.86\)/.test(a) && /rgba\(6, 6, 10, 0\.86\)/.test(b));
  ok("...and the same blur token", (a.match(/--clay-glass-thin/g) ?? []).length === 1
    && (b.match(/--clay-glass-thin/g) ?? []).length === 1);
  // A var() in an inline style is not resolved by React against clay.css tokens
  // in every context, so both carry a literal fallback.
  ok("...with a literal fallback, since these are inline styles",
    /var\(--clay-glass-thin, blur\(3px\)\)/.test(a) && /var\(--clay-glass-thin, blur\(3px\)\)/.test(b));
}
ok("a modal rounds at the panel step", /borderRadius: 18/.test(read("OverlayModal.tsx")));

console.log(fails ? `\n${fails} FAILED` : "\nall glass-and-radius checks passed");
process.exit(fails ? 1 : 0);

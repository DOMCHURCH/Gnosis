// Verify (web UI): the sidebar scrolls in one place, and reads as two tiers.
//
// Two defects, one panel.
//
// The first was structural: every accordion section carried
// `maxHeight: 340, overflowY: "auto"` INSIDE a panel body that was itself
// `overflowY: "auto"`. That is a scrollbar inside a scrollbar — visible as two
// tracks side by side — and it cramped the file tree into a 340px slot while the
// panel below it sat empty. The rule now is that the panel body is the only thing
// in the sidebar that scrolls.
//
// The second was that the four workspace destinations (Sessions, Memory,
// Connections, Webhooks) were rendered by the same component, with the same
// styling, as the project and its file list — so the whole panel read as one
// undifferentiated column of small uppercase monospace with no way in. They are
// now a separate `nav` tier: heavier, counted, and lit when open.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "src");
const read = (f) => readFileSync(path.join(web, f), "utf8");
const sidebar = read("Sidebar.tsx");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- one scroll container -----------------------------------------------------
ok("the section body no longer caps its height", !/maxHeight: 340/.test(sidebar));
ok("...and no longer scrolls on its own",
  !/\{ padding: "2px 0 8px", maxHeight/.test(sidebar));
// The panel body keeps exactly one.
ok("the panel body is still the scroll container",
  /flex: "1 1 auto", minHeight: 0, overflowY: "auto"/.test(sidebar));
ok("...and it is the only overflowY in the file",
  (sidebar.match(/overflowY: "auto"/g) ?? []).length === 1);

// The bodies rendered inside those sections must not reintroduce one.
//
// Each exemption below is a scroller that is NOT inside the sidebar: they belong
// to the full-screen file/note preview and the captured-payload block, where
// scrolling a long document is the whole point. Counted rather than pattern-
// matched so that adding a new one has to be a decision recorded here.
const EXEMPT = {
  "FileBrowser.tsx": 1,   // the preview modal's <pre>, rendered through <Overlay>
  "ObsidianPanel.tsx": 1, // the note preview's body, likewise
  "WebhooksPanel.tsx": 1, // the captured request payload <pre>
};
for (const f of ["FileBrowser.tsx", "ObsidianPanel.tsx", "ConnectionsPanel.tsx", "WebhooksPanel.tsx"]) {
  const n = (read(f).match(/overflow(Y)?: "auto"/g) ?? []).length;
  ok(`${f} adds no nested section scroll`, n === (EXEMPT[f] ?? 0));
}
// ...and the exempt ones really are in the preview, not in the list body.
for (const f of ["FileBrowser.tsx", "ObsidianPanel.tsx"]) {
  ok(`${f}'s scroller belongs to the preview overlay`, /<Overlay[\s>]/.test(read(f)));
}

// --- two tiers ----------------------------------------------------------------
ok("Section takes a tier", /tier\?: "nav" \| "tree"/.test(sidebar));
ok("...defaulting to neither by accident", /const nav = props\.tier === "nav";/.test(sidebar));

// The four destinations are nav; the project and its files are tree.
for (const label of ["Sessions", "Memory", "Connections", "Webhooks"]) {
  const re = new RegExp(`tier="nav"[\\s\\S]{0,320}?label="${label}"|label="${label}"[\\s\\S]{0,320}?tier="nav"`);
  ok(`${label} is on the nav tier`, re.test(sidebar));
}
ok("the project is on the tree tier", /icon="cube" tier="tree"/.test(sidebar));
ok("...and so is Files", /label="Files"[\s\S]{0,80}?tier="tree"/.test(sidebar));

// --- what makes the tiers look different --------------------------------------
ok("nav sections get a lit left rail when open", /inset 2px 0 0 #22D3EE/.test(sidebar));
ok("...heavier type than the tree tier", /fontWeight: nav \? 500 : 400/.test(sidebar));
ok("...and a count chip", /function Count\(/.test(sidebar));
ok("the tree tier gets no rail", /boxShadow: lit \? /.test(sidebar));
ok("file rows sit under a hairline guide",
  /borderLeft: "1px solid rgba\(255,255,255,0\.055\)"/.test(sidebar));
ok("the two tiers are separated by a labelled rule", /function TierLabel\(/.test(sidebar)
  && /<TierLabel>Project<\/TierLabel>/.test(sidebar)
  && /<TierLabel>Workspace<\/TierLabel>/.test(sidebar));

// --- counts must be true or absent --------------------------------------------
// A count chip is only worth having if it cannot be wrong. Webhooks has no list
// in this component, so it deliberately shows nothing rather than 0.
ok("a null count renders nothing", /if \(n === null\) return null;/.test(sidebar));
ok("Webhooks passes no count",
  !/label="Webhooks"[\s\S]{0,200}?count=/.test(sidebar) && !/count=[\s\S]{0,200}?label="Webhooks"/.test(sidebar));
ok("Memory counts nothing when no vault is configured", /count=\{hasVault \? /.test(sidebar));
ok("Connections counts connected servers, not configured ones",
  /m\.status === "connected"/.test(sidebar));

// --- the footer stays reachable -----------------------------------------------
// Sections size to content now, so the tree can be arbitrarily tall; New session
// must not scroll away with it.
ok("New session is outside the scroll area",
  /flex: "0 0 auto", borderTop:/.test(sidebar));

console.log(fails ? `\n${fails} FAILED` : "\nall sidebar-tier checks passed");
process.exit(fails ? 1 : 0);

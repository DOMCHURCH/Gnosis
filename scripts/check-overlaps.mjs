// Layout regression check: no two landmark elements of the web UI may overlap at
// desktop widths.
//
//   node scripts/check-overlaps.mjs "http://127.0.0.1:7788/?token=..."
//
// The office view stacks a lot of chrome (a fixed view/serve toggle, fixed
// TERMINAL / FILES / JOBS buttons, a left panel, a session selector rail, the
// floor) and the z-index scale in web/src/layers.ts decides only what WINS when
// two things are deliberately drawn over each other. This asserts the stronger
// property the layout is supposed to have: in normal use they do not overlap at
// all. Modals and sheets are excluded by definition — they are the exception.
//
// Needs a live `dom serve` and playwright's chromium (already installed via
// @playwright/mcp). Exits non-zero on the first overlapping pair.

const WIDTHS = [1280, 1440, 1920];
const HEIGHT = 900;

// Every landmark carries a data-testid; nothing here depends on inline styles.
const LANDMARKS = [
  "page-header",
  "view-toggle",
  "left-panel",
  "session-selector",
  "session-title",
  "floor-container",
  "floor-header",
  "right-panel",
  "chip-floor",
  "chip-kanban",
  "chip-serve",
  "chip-terminal",
];

// A 1px seam is a border touching a border, not an overlap.
const TOLERANCE = 1;

const url = process.argv[2];
if (!url) {
  console.error('usage: node scripts/check-overlaps.mjs "<tokenized dom serve url>"');
  process.exit(2);
}

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright is not installed here — `npm i -D playwright` (or run this from a checkout that has it)");
  process.exit(2);
}

/** Overlap area of two DOMRects, ignoring a 1px border seam. */
function overlap(a, b) {
  const x = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) - TOLERANCE;
  const y = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) - TOLERANCE;
  return x > 0 && y > 0 ? { x: Math.round(x), y: Math.round(y) } : null;
}

const browser = await chromium.launch();
let failures = 0;

for (const width of WIDTHS) {
  const page = await browser.newPage({ viewport: { width, height: HEIGHT } });
  await page.goto(url, { waitUntil: "networkidle" });
  // The floor mounts a WebGL canvas and the panels fetch their trees; give the
  // first paint a beat so the boxes measured are the settled ones.
  await page.waitForSelector('[data-testid="floor-container"]', { timeout: 15000 });
  await page.waitForTimeout(1200);

  const boxes = {};
  for (const id of LANDMARKS) {
    const el = page.locator(`[data-testid="${id}"]`).first();
    if ((await el.count()) === 0) continue; // not rendered at this width (by design)
    const box = await el.boundingBox();
    if (box) boxes[id] = box;
  }

  // A landmark inside another landmark (the floor header inside the floor
  // container) shares its box by definition — that is nesting, not overlap.
  const nested = await page.evaluate((ids) => {
    const found = ids.map((id) => [id, document.querySelector(`[data-testid="${id}"]`)]).filter(([, el]) => el);
    const pairs = [];
    for (const [a, ea] of found) for (const [b, eb] of found) if (a !== b && ea.contains(eb)) pairs.push(`${a}|${b}`);
    return pairs;
  }, LANDMARKS);
  const contains = new Set(nested);

  const names = Object.keys(boxes);
  const bad = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const [a, b] = [names[i], names[j]];
      if (contains.has(`${a}|${b}`) || contains.has(`${b}|${a}`)) continue;
      const hit = overlap(boxes[a], boxes[b]);
      if (hit) bad.push(`${a} × ${b} — ${hit.x}×${hit.y}px`);
    }
  }
  // A landmark whose CONTENT is wider than its box paints that content over its
  // neighbour, which box-vs-box comparison never sees — the left panel's tab row
  // spilling across the session selector was exactly this.
  const spills = await page.evaluate((ids) => {
    const out = [];
    for (const id of ids) {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el || getComputedStyle(el).overflowX !== "visible") continue;
      const over = el.scrollWidth - el.clientWidth;
      if (over > 1) out.push(`${id} — content ${over}px wider than its box`);
    }
    return out;
  }, LANDMARKS);
  for (const s of spills) bad.push(s);

  // Nothing may spill horizontally either: a sideways scrollbar means something
  // is wider than the viewport, which reads as an overlap to the user.
  const scrollX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  if (bad.length || scrollX > 0) {
    failures++;
    console.log(`FAIL ${width}px — ${names.length} landmarks`);
    for (const b of bad) console.log(`     overlap: ${b}`);
    if (scrollX > 0) console.log(`     horizontal overflow: ${scrollX}px`);
  } else {
    console.log(`PASS ${width}px — ${names.length} landmarks, no overlaps, no horizontal overflow`);
  }
  await page.close();
}

await browser.close();
console.log(failures ? `\n❌ ${failures}/${WIDTHS.length} widths have overlapping elements` : `\n✅ no overlapping elements at ${WIDTHS.join(" / ")}px`);
process.exit(failures ? 1 : 0);

// Capture the README screenshot from a live `dom serve`.
//
//   node scripts/screenshot.mjs "http://127.0.0.1:7788/?token=..." docs/screenshot.png
//
// Staff the floor first so the shot shows a working office rather than an empty
// one — ask the running agent to "fill the office" (the office tool), or place
// them from the console with window.gnosisOffice.fill().
//
// Fails loudly if the 3D floor did not come up: a headless browser without a
// WebGL context silently falls back to the flat SVG floor, and shipping that as
// "the 3D office floor" is exactly the drift this replaces.
const url = process.argv[2];
const out = process.argv[3] ?? "docs/screenshot.png";
const width = Number(process.argv[4] ?? 1800);
const height = Number(process.argv[5] ?? 1150);

if (!url) {
  console.error('usage: node scripts/screenshot.mjs "<tokenized dom serve url>" [out.png] [width] [height]');
  process.exit(2);
}

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright is not installed here — `npm i -D playwright`");
  process.exit(2);
}

const browser = await chromium.launch({
  // SwiftShader gives headless chromium a real WebGL context, so the 3D floor
  // renders instead of falling back to the SVG one.
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
page.on("console", (m) => { if (m.type() === "error") console.log(`  page error: ${m.text()}`); });

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="three-floor"]', { timeout: 20000 }).catch(() => {
  console.error("no 3D floor — the page fell back to the SVG floor (no WebGL context in this browser)");
  process.exit(1);
});

// Wait for the office to actually be staffed, then for the scene to settle.
const staffed = await page
  .waitForFunction(() => (window.domThreeScene?.list?.().length ?? document.querySelectorAll(".agent-badge").length) > 0, null, { timeout: 20000 })
  .then(() => true)
  .catch(() => false);
if (!staffed) console.log("! no agents on the floor — capturing it empty");
await page.waitForTimeout(2500);

const zones = await page.evaluate(() => [...document.querySelectorAll(".zone-label .zl-count")].map((e) => e.textContent));
console.log(`zones: ${zones.join(" · ")}`);

await page.screenshot({ path: out, fullPage: true });
console.log(`wrote ${out} (${width}×${height} @2x)`);
await browser.close();

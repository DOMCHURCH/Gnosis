// Verify (voice overlay): the PACKAGED app ships the overlay we just tested.
//
// Every other overlay suite reads electron/voice-overlay.html off the working
// tree. That is the file the developer edits and it is not the file the user
// runs: electron-builder packs the app into resources/app.asar, and a stale or
// misconfigured `files` glob would ship the previous overlay while all 140+
// source-level assertions went on passing. This suite closes that gap by reading
// the archive itself.
//
// It SKIPS loudly when there is nothing packaged — `npm run verify` must not
// depend on a five-minute `npm run dist`. The skip prints the command to run, so
// "it skipped" can never be mistaken for "it passed".
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (n, c, d) => { console.log((c ? "PASS " : "FAIL ") + n + (d ? " — " + d : "")); if (!c) fails++; };

// electron-builder's win target lands in dist/win-unpacked; a --dir build lands
// in the same place. Both are checked so either kind of build satisfies this.
const candidates = [
  path.join(root, "dist", "win-unpacked", "resources", "app.asar"),
  path.join(root, "dist", "win-ia32-unpacked", "resources", "app.asar"),
];
const asar = candidates.find((p) => existsSync(p));

if (!asar) {
  console.log("SKIP packaged-overlay checks — no build found at dist/win-unpacked/resources/app.asar");
  console.log("     run `npm run dist` (or `npx electron-builder --win --dir`) first");
  process.exit(0);
}

const age = Math.round((Date.now() - statSync(asar).mtimeMs) / 60000);
console.log(`reading ${path.relative(root, asar)} (built ${age} min ago)`);

/*
 * Read the overlay out of the archive without depending on the `asar` package.
 *
 * An asar is a 16-byte header, a JSON directory, then the file bodies
 * concatenated. Rather than reimplement the format, this pulls the whole archive
 * into memory and finds the overlay by its own opening bytes — the file is ~60KB
 * of a ~10MB archive, and the two sentinels below (the doctype and the closing
 * tag) bound it exactly. Cruder than a parser and it cannot silently succeed on
 * the wrong file: if the markers are missing, there is no overlay in there.
 */
const buf = readFileSync(asar);
const text = buf.toString("utf8");
const start = text.indexOf("<!doctype html>\n<html lang=\"en\">\n  <head>\n    <meta charset=\"utf-8\" />\n    <meta name=\"color-scheme\" content=\"dark\" />\n    <title>Gnosis voice</title>");
ok("the overlay page is inside the archive", start >= 0, start >= 0 ? "at byte " + start : "not found");
const packed = start >= 0 ? text.slice(start, text.indexOf("</html>", start) + 7) : "";
const source = readFileSync(path.join(root, "electron", "voice-overlay.html"), "utf8");

// --- 1. it is THIS overlay, not a previous one -------------------------------
//
// Tokens chosen because each one is unique to a change that had to ship: a build
// that predates any of them is a build the source-level suites did not test.
const MARKERS = [
  ['the horizontal status rail', 'container-name: rail'],
  ['...with its non-wrapping row', 'flex-wrap: nowrap'],
  ['...and the compact single-chip fallback', '.steps .step:not(.on) { display: none; }'],
  ['the hint as a sibling of the row', '<div id="escHint">'],
  ['the bullet only on the live chip', '.step.on .bullet { display: block; }'],
  ['the environmental reflection', 'rgba(34, 211, 238, 0.055), transparent 66%'],
  ['the accessible name on the shield', 'aria-label="Permissions'],
  ['the accessible name on the microphone button', 'aria-label="Turn voice off"'],
  ['the accessible name on the close button', 'aria-label="End this conversation"'],
  ['the expand guard that covers every control', 'if (e.target.closest("button")) return;'],
  ['the answering step (not a READY step)', 'speaking: "stepAnswering"'],
];
for (const [what, token] of MARKERS) {
  ok("the packaged overlay carries " + what, packed.includes(token), token.slice(0, 46));
}

// --- 2. and nothing forbidden came back with it ------------------------------
//
// The black-rectangle bug. Asserted against the ARCHIVE because that is the copy
// that runs: a source-level check cannot see a stale pack.
for (const banned of ["backdrop-filter:", "-webkit-backdrop-filter:", "mix-blend-mode:"]) {
  ok("no " + banned + " in the packaged overlay", !packed.includes(banned));
}

// --- 3. the packed copy is the working copy ----------------------------------
//
// The markers above prove it is recent; this proves it is IDENTICAL, which is
// the only way to know the build is not one edit behind.
ok("the packaged overlay is byte-identical to electron/voice-overlay.html",
  packed.length > 0 && packed === source.slice(source.indexOf("<!doctype html>"), source.indexOf("</html>") + 7),
  "packed " + packed.length + " chars vs source " + (source.indexOf("</html>") + 7 - source.indexOf("<!doctype html>")));

// --- 4. voice.js went in too, with the shadow padding they must agree on -----
{
  const jsStart = text.indexOf("const OVERLAY = { collapsed:");
  ok("voice.js is inside the archive", jsStart >= 0);
  if (jsStart >= 0) {
    const slice = text.slice(jsStart, jsStart + 4000);
    const pad = slice.match(/const SHADOW_PAD = (\d+);/)?.[1];
    const css = source.match(/--shadow-pad: (\d+)px/)?.[1];
    ok("the packaged voice.js reserves shadow room", !!pad, "SHADOW_PAD " + pad);
    ok("...and it matches the packaged stylesheet's inset", pad === css, "js " + pad + " vs css " + css);
    ok("the packaged pill hint is the single-clause one", text.includes('hint: "Esc or × ends this chat"'));
  }
}

// --- 5. the diagnostic harness shipped, so the manual check is runnable ------
ok("the overlay diagnostic entry is in the archive",
  text.includes("GNOSIS_OVERLAY_DIAGNOSTIC"), "GNOSIS_OVERLAY_DIAGNOSTIC");

console.log(fails ? "\n" + fails + " FAILED" : "\nall packaged-overlay checks passed");
process.exit(fails ? 1 : 0);

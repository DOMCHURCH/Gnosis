// Regression harness: run every verify/s*.mjs suite in its own process (each
// mocks globals / isolates $USERPROFILE, so they must not share a process) and
// report an aggregate pass/fail. Exits non-zero if any suite fails.
//
//   npm run build && npm run verify
//
// Each suite is self-contained, offline (fetch is mocked; no real network), and
// isolated to a throwaway home — nothing here touches the real ~/.dom.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(dir)
  .filter((f) => /^s\d.*\.mjs$/.test(f)) // s1-*, s2-*, s3-* (skips _probe, run-all)
  .sort();

let failed = 0;
for (const f of suites) {
  console.log(`\n──────────── ${f} ────────────`);
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: "inherit" });
  if (r.status !== 0) {
    failed++;
    console.log(`  ✗ ${f} FAILED (exit ${r.status})`);
  }
}

console.log("\n════════════════════════════════════════");
console.log(failed ? `❌ ${failed}/${suites.length} suite(s) FAILED` : `✅ all ${suites.length} suites passed`);
process.exit(failed ? 1 : 0);

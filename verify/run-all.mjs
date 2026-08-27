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

// A suite that hangs used to stall the whole harness with no sign of WHICH one:
// the run just sat there until an outer timeout killed it, taking the name with
// it. Cap each suite instead, so a hang becomes a named failure.
const SUITE_TIMEOUT_MS = Number(process.env.VERIFY_SUITE_TIMEOUT_MS ?? 120_000);
// Suites this slow are worth seeing even when green: an intermittent failure is
// usually a suite that crept up on a timeout, and the trend is the early warning.
const SLOW_MS = Number(process.env.VERIFY_SLOW_MS ?? 20_000);

const failures = [];
const slow = [];
for (const f of suites) {
  console.log(`\n──────────── ${f} ────────────`);
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, f)], {
    stdio: "inherit",
    timeout: SUITE_TIMEOUT_MS,
    // Suites that spawn the real binary must not connect MCP servers: an
    // isolated $USERPROFILE has no mcp.json, so boot would write the default
    // registry and npx-fetch three servers off the network. Offline and
    // deterministic is the whole point of this harness.
    env: { ...process.env, GNOSIS_SKIP_MCP: "1" },
  });
  const ms = Date.now() - started;
  if (ms >= SLOW_MS) slow.push([f, ms]);
  // spawnSync reports a timeout as a kill signal, not a non-zero exit code.
  // Windows does not surface the kill as a signal, so elapsed time is the only
  // reliable tell: at or past the cap with a non-zero exit means it was killed.
  const timedOut = r.error?.code === "ETIMEDOUT" || r.signal != null || (ms >= SUITE_TIMEOUT_MS && r.status !== 0);
  if (timedOut) {
    failures.push([f, `TIMED OUT after ${Math.round(ms / 1000)}s`]);
    console.log(`  ✗ ${f} TIMED OUT after ${Math.round(ms / 1000)}s`);
  } else if (r.status !== 0) {
    failures.push([f, `exit ${r.status}`]);
    console.log(`  ✗ ${f} FAILED (exit ${r.status})`);
  }
}

console.log("\n════════════════════════════════════════");
if (slow.length) {
  console.log(`slowest suites (>= ${Math.round(SLOW_MS / 1000)}s):`);
  for (const [f, ms] of slow.sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`   ${(ms / 1000).toFixed(1)}s  ${f}`);
}
// Repeat every failing name at the END: scrolling back through 100 suites of
// output to find which one failed is how a flake stays unidentified.
if (failures.length) {
  console.log(`❌ ${failures.length}/${suites.length} suite(s) FAILED`);
  for (const [f, why] of failures) console.log(`   ✗ ${f} — ${why}`);
} else {
  console.log(`✅ all ${suites.length} suites passed`);
}
process.exit(failures.length ? 1 : 0);

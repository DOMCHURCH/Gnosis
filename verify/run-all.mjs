// Regression harness: run every verify/s*.mjs suite in its own process (each
// mocks globals / isolates $USERPROFILE, so they must not share a process) and
// report an aggregate pass/fail. Exits non-zero if any suite fails.
//
//   npm run build && npm run verify
//
// Each suite is self-contained, offline (fetch is mocked; no real network), and
// isolated to a throwaway home — nothing here touches the real ~/.dom.
import { spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
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

// A suite that never actually asserted anything — it hit its own "the
// environment for this check isn't available" branch (no display, no
// packaged build, …) and printed a SKIP line instead of running — must not
// silently count as a pass. `stdio: "inherit"` gave the child a direct pipe
// to this process's own stdout, which is fast and simple but leaves run-all
// with no way to SEE what the child printed; captured here instead so a
// suite-level skip can be told apart from a real one. A suite that ran real
// checks and skipped only ONE of them by design (e.g. "hidden at this size")
// still prints its own PASS lines alongside that, so the rule is: a leading
// SKIP line with no PASS line anywhere means nothing was actually verified.
function isSuiteLevelSkip(stdout) {
  return /^SKIP /m.test(stdout) && !/^PASS /m.test(stdout);
}
function firstSkipLine(stdout) {
  return stdout.split(/\r?\n/).find((l) => l.startsWith("SKIP "))?.trim() ?? "skipped";
}

const failures = [];
const slow = [];
const skipped = [];
for (const f of suites) {
  console.log(`\n──────────── ${f} ────────────`);
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, f)], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SUITE_TIMEOUT_MS,
    encoding: "utf8",
    // Suites that spawn the real binary must not connect MCP servers: an
    // isolated $USERPROFILE has no mcp.json, so boot would write the default
    // registry and npx-fetch three servers off the network. Offline and
    // deterministic is the whole point of this harness.
    env: { ...process.env, GNOSIS_SKIP_MCP: "1" },
  });
  // Printed after the fact rather than streamed live (the tradeoff for being
  // able to inspect it below) — full content and suite order are unchanged.
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
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
  } else if (isSuiteLevelSkip(r.stdout ?? "")) {
    skipped.push([f, firstSkipLine(r.stdout ?? "")]);
  }
}

/*
 * The acceptance server, which lives in its own package.
 *
 * Its suite is not verify/s*.mjs so the glob above never saw it, and neither
 * workflow ran it either — the component holding the legal record of who
 * accepted the Terms was the one part of this repo whose tests only ran when
 * someone remembered to cd into it by hand. It needs no database (the pool is
 * stubbed throughout), so there is no reason for it to be optional.
 *
 * Skipped rather than failed when its dependencies are not installed: a fresh
 * clone has no acceptance-server/node_modules, and "you have not run npm
 * install in a subpackage" is not a regression.
 */
{
  const name = "acceptance-server/test/run.mjs";
  const sub = path.join(dir, "..", "acceptance-server");
  const entry = path.join(sub, "test", "run.mjs");
  console.log(`
──────────── ${name} ────────────`);
  if (!existsSync(entry)) {
    console.log("SKIP not present");
    skipped.push([name, "SKIP not present"]);
  } else if (!existsSync(path.join(sub, "node_modules"))) {
    console.log("SKIP dependencies not installed — run: npm --prefix acceptance-server ci");
    skipped.push([name, "SKIP dependencies not installed"]);
  } else {
    const started = Date.now();
    const r = spawnSync(process.execPath, [entry], { stdio: "inherit", timeout: SUITE_TIMEOUT_MS, cwd: sub });
    const ms = Date.now() - started;
    if (ms >= SLOW_MS) slow.push([name, ms]);
    if (r.status !== 0) {
      failures.push([name, `exit ${r.status}`]);
      console.log(`  ✗ ${name} FAILED (exit ${r.status})`);
    }
    suites.push(name);
  }
}

console.log("\n════════════════════════════════════════");
if (skipped.length) {
  console.log(`⚠ ${skipped.length} suite(s) SKIPPED — verified nothing, do not read as a pass:`);
  for (const [f, why] of skipped) console.log(`   ○ ${f} — ${why}`);
}
if (slow.length) {
  console.log(`slowest suites (>= ${Math.round(SLOW_MS / 1000)}s):`);
  for (const [f, ms] of slow.sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`   ${(ms / 1000).toFixed(1)}s  ${f}`);
}
// Repeat every failing name at the END: scrolling back through 100 suites of
// output to find which one failed is how a flake stays unidentified.
if (failures.length) {
  console.log(`❌ ${failures.length}/${suites.length} suite(s) FAILED`);
  for (const [f, why] of failures) console.log(`   ✗ ${f} — ${why}`);
} else if (skipped.length) {
  console.log(`✅ ${suites.length - skipped.length}/${suites.length} suites passed, ${skipped.length} skipped (see above)`);
} else {
  console.log(`✅ all ${suites.length} suites passed`);
}
process.exit(failures.length ? 1 : 0);

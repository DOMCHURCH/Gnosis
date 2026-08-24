// Ink renders differently under CI, and it breaks every suite that asserts on a
// rendered frame.
//
// ink/build/ink.js imports `is-in-ci`, which is true whenever `CI` is set (or
// `CONTINUOUS_INTEGRATION`, or any `CI_*` variable). In that mode Ink stops
// writing intermediate frames — no erase-and-redraw, output is deferred and
// flushed at the end — so that a real CI log does not fill up with thousands of
// redraws. That is correct behaviour for a real CI console.
//
// It is wrong for these suites. They hand Ink a FAKE stdout (an EventEmitter
// with isTTY/columns/rows) and assert on the collected frames *between*
// keystrokes. Under CI mode those frames are never written, so every
// "is this text on screen?" assertion reads an empty string. The tell is that
// the positive assertions fail while the negative ones ("no model id appears")
// all pass — an empty frame satisfies every negative check. Suites pass locally
// and fail on any CI runner, which is exactly backwards from what a regression
// harness is for.
//
// The fake terminal is not the CI console, so CI-mode batching must not apply to
// it. Clear the variables is-in-ci reads. This module MUST be imported before
// ink — ESM evaluates dependencies in import order, so `import "./_inkenv.mjs"`
// belongs above the ink import (and above anything that pulls ink in, such as
// dist/ui/*). Named with a leading underscore so run-all.mjs (which globs
// s*.mjs) never runs it as a suite.
for (const key of Object.keys(process.env)) {
  if (key === "CI" || key === "CONTINUOUS_INTEGRATION" || key.startsWith("CI_")) {
    delete process.env[key];
  }
}

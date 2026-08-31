// Wait for a condition instead of guessing how long it takes.
//
// The flakes this exists to end all had the same shape: a suite starts a child
// process — a shell, a node job, a build — sleeps a hand-picked number of
// milliseconds, and asserts. That number is tuned on a developer's idle machine
// and is a coin flip on a loaded CI runner, where the same work takes several
// times longer. The suites were not testing anything different when they failed;
// they were testing the same thing too early.
//
// Two observed failures, both this shape:
//   s33-serve-jobs  sleep(400)  before asserting a spawned node process had
//                   already printed  ("/api/job returns the captured output")
//   s34-pty         sleep(600)  for a shell to boot, then sleep(1400) for it to
//                   echo         ("the pty echoes typed input back")
//
// A poll with a generous DEADLINE is strictly better than a fixed sleep in both
// directions: it returns as soon as the condition holds, so the common case gets
// faster, and it tolerates a slow machine, so the rare case stops failing. The
// deadline still bounds a genuine hang, which is the thing a sleep was
// protecting against in the first place.
//
// s16 and s23 already had a local waitForUrl doing exactly this. This is that
// idea, shared.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll `predicate` until it returns truthy, or the deadline passes.
 *
 * @param predicate  sync or async; a throw counts as "not yet", because a
 *                   condition that is not ready often fails by throwing (a
 *                   connection refused, a file not yet written) and that is not
 *                   a reason to abandon the wait.
 * @returns the truthy value, or null on timeout — the caller's `ok()` turns
 *          null into a readable failure, which beats an exception that loses
 *          which assertion was waiting.
 */
export async function waitFor(predicate, { timeout = 15000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const v = await predicate();
      if (v) return v;
    } catch {
      /* not ready yet */
    }
    if (Date.now() >= deadline) return null;
    await sleep(interval);
  }
}

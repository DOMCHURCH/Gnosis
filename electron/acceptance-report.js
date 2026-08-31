// Sends the acceptance record to the project's server, and never lets that
// failing cost the user anything.
//
// The local record in ~/.dom/acceptance.json is written first and remains
// authoritative for gating the welcome window. This module is strictly
// additional: it puts a copy somewhere the accepting user cannot edit, because a
// record whose custodian is its subject does not settle a dispute about what its
// subject agreed to.
//
// THREE RULES THIS FILE EXISTS TO KEEP:
//
//   1. Nothing is sent before acceptance. Not a ping, not a version check, not
//      an empty request. A user who is shown the Terms and closes the window has
//      transmitted nothing, and a user still on v1 terms who never accepts v2
//      transmits nothing ever.
//   2. Nothing blocks. The send is fire-and-forget. If the server is down, the
//      user's ability to use software they already installed does not depend on
//      the project's infrastructure being up.
//   3. Nothing is lost. A failed send is queued and retried on later launches,
//      because otherwise everyone who installs offline is silently never
//      recorded and the whole mechanism quietly hollows out.
//
// It is not analytics. One request per accepted document, and no other call to
// the project ever. The Terms say so, so this file has to mean it.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * The deployed endpoint.
 *
 * Live since 2026-08-31 as the `gnosis-acceptance` service in the Railway
 * project `gnosis`, alongside — and separate from — the Postgres service that
 * actually holds the rows. Those being two services rather than one is not a
 * detail: deploying the app into the database's own service is what broke the
 * first attempt, because DATABASE_URL then resolved to the app itself.
 *
 * The placeholder guard below is kept, and kept meaningful. While ENDPOINT
 * still contains the placeholder the module is INERT — it sends nothing and
 * queues nothing — because shipping a build that posts acceptances to a
 * hostname that does not resolve would produce a queue that never drains and a
 * Terms document promising a transmission that does not happen. Better to do
 * nothing honestly than to half-do it. Now that a real URL is in place the
 * guard is dormant, but it must survive: it is what makes a fork, or a future
 * redeploy that clears this constant, fail safe rather than fail silently.
 *
 * GNOSIS_ACCEPTANCE_URL overrides it. That is for tests and for pointing a local
 * build at a staging deploy — a shipped build has no such variable set and falls
 * through to the constant, which is the only value users ever exercise.
 */
const ENDPOINT =
  process.env.GNOSIS_ACCEPTANCE_URL ||
  "https://gnosis-acceptance-production.up.railway.app/accept";
const PLACEHOLDER = ENDPOINT.includes("REPLACE-ME");

/** How long to wait before deciding the server is not going to answer. */
const TIMEOUT_MS = 10_000;

/**
 * How many launches a failed record keeps being retried for.
 *
 * Not infinite. A payload the server has refused sixty times over sixty launches
 * is not going to start succeeding, and a queue that never gives up is a queue
 * that grows forever on a machine that is permanently behind a firewall.
 */
const MAX_ATTEMPTS = 60;

export function queuePath() {
  return path.join(os.homedir(), ".dom", "acceptance-queue.json");
}

/** True when a real endpoint has been configured. Exported for tests. */
export function isConfigured() {
  return !PLACEHOLDER;
}

/**
 * Build the payload from an already-written local record.
 *
 * Takes the values from the local record rather than re-deriving them, so the
 * two copies cannot disagree — the point of the server row is to corroborate the
 * local one, which it cannot do if it was assembled from a different source.
 */
export function buildPayload({ machine, entry, email }) {
  const payload = {
    installId: machine,
    termsVersion: entry.termsVersion,
    termsSha256: entry.sha256,
    appVersion: entry.appVersion,
    acceptedAt: entry.acceptedAt,
  };
  // Absent and empty must mean the same thing. Sending "" would record that an
  // address was volunteered when it was not.
  if (typeof email === "string" && email.trim() !== "") payload.email = email.trim();
  return payload;
}

async function readQueue() {
  try {
    const raw = await fs.readFile(queuePath(), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeQueue(items) {
  await fs.mkdir(path.dirname(queuePath()), { recursive: true }).catch(() => {});
  await fs.writeFile(queuePath(), JSON.stringify(items, null, 2) + "\n", "utf8").catch(() => {
    /* an unwritable queue must not break acceptance either */
  });
}

/**
 * POST one payload.
 *
 * @returns {"sent"|"retry"|"drop"}
 *   sent  — recorded, or already on file. Done with it.
 *   retry — transient. Keep it and try again next launch.
 *   drop  — the server refused it as malformed. Retrying cannot help.
 */
export async function postOnce(payload, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (res.status === 200) return "sent";
    // 4xx USUALLY means the payload itself is wrong, and sending the same bytes
    // again would get the same answer — so those are dropped rather than
    // retried forever.
    //
    // Three are exceptions, and they matter here more than they would anywhere
    // else. 408, 425 and 429 are 4xx codes that describe the TIMING of the
    // request, not its content: too slow, too early, too many. The bytes are
    // fine and the same bytes will succeed later. Dropping those would discard
    // a real acceptance because a proxy was busy — a silent hole in the one
    // record whose whole value is being complete.
    //
    // Nothing in this service emits them today; an edge proxy or CDN in front
    // of it can, and that is exactly the case the client cannot see coming.
    if (res.status === 408 || res.status === 425 || res.status === 429) return "retry";
    if (res.status >= 400 && res.status < 500) return "drop";
    return "retry";
  } catch {
    // Offline, DNS failure, timeout. All transient by assumption.
    return "retry";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Record an acceptance with the server, queueing it if that fails.
 *
 * Never throws and never blocks the caller on the result.
 */
export async function report(payload, fetchImpl = globalThis.fetch) {
  if (PLACEHOLDER) return "skipped";
  const outcome = await postOnce(payload, fetchImpl);
  if (outcome === "retry") {
    const queue = await readQueue();
    // Same document, same install: already waiting. Do not queue it twice.
    const already = queue.some(
      (q) => q?.payload?.installId === payload.installId && q?.payload?.termsSha256 === payload.termsSha256,
    );
    if (!already) await writeQueue([...queue, { payload, attempts: 1 }]);
  }
  return outcome;
}

/**
 * Retry everything queued. Called once at launch.
 *
 * Runs after the window is already up — draining a queue is never a reason for
 * the user to wait for a network round trip.
 */
export async function drainQueue(fetchImpl = globalThis.fetch) {
  if (PLACEHOLDER) return { sent: 0, kept: 0, dropped: 0 };
  const queue = await readQueue();
  if (queue.length === 0) return { sent: 0, kept: 0, dropped: 0 };

  const keep = [];
  let sent = 0;
  let dropped = 0;

  for (const item of queue) {
    if (!item?.payload) continue; // corrupt entry; discarding it loses nothing
    const attempts = Number(item.attempts ?? 0) + 1;
    const outcome = await postOnce(item.payload, fetchImpl);
    if (outcome === "sent") sent++;
    else if (outcome === "drop") dropped++;
    else if (attempts >= MAX_ATTEMPTS) dropped++;
    else keep.push({ ...item, attempts });
  }

  await writeQueue(keep);
  return { sent, kept: keep.length, dropped };
}

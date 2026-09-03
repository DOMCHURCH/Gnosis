// The acceptance endpoint.
//
// One route that matters: POST /accept. It exists so that the record of who
// agreed to the Terms is not held solely by the person who agreed.
//
// WHAT THIS DELIBERATELY IS NOT: it is not analytics. There is no event stream,
// no heartbeat, no usage reporting, and no second call of any kind. The client
// contacts this service exactly once per accepted document and never again. The
// Terms say that, so the code has to mean it.

import Fastify from "fastify";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateAcceptance } from "./validate.js";
import { insertAcceptance, migrate, closePool } from "./db.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = "0.0.0.0"; // Railway routes to the container's external interface.

// --- rate limiting -----------------------------------------------------------
//
// POST /accept is deliberately unauthenticated (see the header comment), and
// installId proves nothing — it's a client-chosen 32-hex value with no proof
// of ownership. Without a limit, anyone can script unlimited distinct rows,
// polluting the evidentiary table and/or exhausting the 5-connection pg pool.
// A single in-memory fixed-window counter is enough for a single-process
// service with one route to protect; no dependency added, keeping this
// project's deliberately small footprint (fastify + pg) as it is.
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX = 20; // per IP per window — generous for the client's own documented retry/backoff, bounds a script
const RATE_LIMIT_MAX_TRACKED_IPS = 10_000; // hard ceiling on the table itself, independent of window expiry
const hits = new Map();

/** True when `ip` has exceeded its window, OR the tracked-IP table itself is
 * full — shedding load rather than growing the map without bound is the
 * right failure mode for an unauthenticated write route facing many distinct
 * source IPs, not just a repeat one. */
function isRateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (entry && now < entry.resetAt) {
    entry.count++;
    return entry.count > RATE_LIMIT_MAX;
  }
  if (hits.size >= RATE_LIMIT_MAX_TRACKED_IPS) {
    // Opportunistic prune before refusing outright — most of the time this
    // clears plenty of expired entries and legitimate traffic never notices.
    for (const [k, e] of hits) if (now >= e.resetAt) hits.delete(k);
    if (hits.size >= RATE_LIMIT_MAX_TRACKED_IPS) return true;
  }
  hits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  return false;
}

/** Test-only: clear accumulated rate-limit state between test cases that need
 * a clean slate (state is module-level and shared across buildServer() calls
 * in the same process, same as a real deployment shares it across requests). */
export function resetRateLimitForTests() {
  hits.clear();
}

export function buildServer({ insert = insertAcceptance, logger = true, isReady = () => true } = {}) {
  const app = Fastify({
    logger,
    // The payload is six short fields. Anything larger is not an acceptance.
    bodyLimit: 16 * 1024,
    // `true` trusts the WHOLE client-supplied X-Forwarded-For chain, so a
    // client that sends its own XFF header before Railway's edge appends the
    // real one can make request.ip resolve to a fake, attacker-chosen value
    // (Fastify takes the leftmost entry) — rotating that value per request
    // bypasses the IP rate limit below entirely. The fix is a specific
    // trusted-proxy value (this Fastify version's numeric trustProxy
    // deliberately "fails closed" to the raw socket address instead of
    // hop-counting — see node_modules/fastify/lib/request.js
    // getTrustProxyFn's own comment — so a bare hop count is NOT the right
    // knob here), but that requires knowing Railway's actual edge IP
    // range/CIDR, which isn't something to guess: getting it wrong would
    // make request.ip resolve to Railway's OWN shared edge address for
    // EVERY distinct user, turning the per-IP limit below into one global
    // counter across all traffic — a worse regression than the spoofing gap
    // it would "fix". Left as `true`, documented rather than silently
    // guessed at. See SECURITY.md / the release audit notes.
    trustProxy: true,
  });

  // Railway's healthcheck, and a cheap way to confirm a deploy is live.
  //
  // This reports ok:true even before the schema is in place, and that is
  // deliberate. The healthcheck decides whether the deploy is allowed to exist
  // at all; failing it while waiting for Postgres to finish booting kills the
  // very process that is waiting, which is how the first deploy of this service
  // crash-looped. Liveness and readiness are different questions, so `ready`
  // answers the second one without letting it end the process.
  app.get("/health", async () => ({ ok: true, ready: isReady() }));

  app.post("/accept", async (request, reply) => {
    if (isRateLimited(request.ip)) {
      return reply.code(429).send({ ok: false, error: "too many requests; try again later" });
    }
    const result = validateAcceptance(request.body);
    if (!result.ok) {
      // 400 is meaningful to the client: it stops retrying on a 4xx, because a
      // malformed payload will not become well-formed by being sent again.
      return reply.code(400).send({ ok: false, error: result.error });
    }

    try {
      const { id, created } = await insert(result.value);
      // 200 for both a new row and an existing one. "Already recorded" is the
      // correct end state for a retry, not an error — see insertAcceptance.
      return reply.code(200).send({ ok: true, id, created });
    } catch (err) {
      request.log.error({ err }, "failed to record acceptance");
      // 5xx tells the client to keep the payload queued and try again later. An
      // acceptance lost to a database blip is an acceptance that never happened
      // as far as the record is concerned, so the client must not give up.
      return reply.code(503).send({ ok: false, error: "could not record; retry later" });
    }
  });

  return app;
}

// Only start listening when run directly, so tests can import buildServer.
// Compared as resolved file URLs because a bare string comparison gets the
// answer wrong on Windows, where argv[1] is a backslash path and import.meta.url
// is a file:// URL.
const runDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

/*
 * Turn a connection failure into something a human can act on.
 *
 * node's happy-eyeballs dialling throws an AggregateError whose `.message` is
 * the EMPTY STRING — every useful detail lives on `.errors[]`. Logging
 * `err.message` therefore produced `err=""` in the retry loop, which is worse
 * than logging nothing: it looks like the error was captured when it was not.
 * The distinctions that matter here are all in those sub-errors:
 *
 *   ECONNREFUSED - the host resolved and answered. Postgres is not up YET.
 *   ETIMEDOUT    - the address is routable but nothing replied. Usually the
 *                  private network is not attached to this service.
 *   ENOTFOUND /
 *   EAI_AGAIN    - the hostname does not resolve. DATABASE_URL points at a
 *                  service name that does not exist from here.
 *
 * The first is worth waiting out. The other two are misconfiguration and no
 * amount of retrying will fix them, so they must be visible immediately.
 */
function describeConnectError(err) {
  const parts = Array.isArray(err?.errors) && err.errors.length ? err.errors : [err];
  const seen = parts.map((e) => {
    const where = e?.address ? `${e.address}:${e.port ?? "?"}` : "";
    return [e?.code ?? e?.name ?? "unknown", where].filter(Boolean).join(" ");
  });
  const codes = new Set(parts.map((e) => e?.code));
  const hint =
    codes.has("ENOTFOUND") || codes.has("EAI_AGAIN")
      ? "hostname does not resolve — check DATABASE_URL is set and references the Postgres service"
      : codes.has("ETIMEDOUT")
        ? "routable but silent — check the private network is attached to this service"
        : codes.has("ECONNREFUSED")
          ? "refused — Postgres is reachable but not accepting connections yet"
          : err?.message || "no detail available";
  return { attempts: seen, hint };
}

if (runDirectly) {
  // Migration state, owned by the boot sequence and read by /health.
  let ready = false;

  const app = buildServer({ isReady: () => ready });

  /*
   * LISTEN FIRST, MIGRATE SECOND. The original order was the other way round and
   * it could not deploy.
   *
   * On Railway the database is a separate service on the private network, and
   * neither that network nor Postgres itself is reachable the instant this
   * container starts. Migrating before listening meant: connect, ETIMEDOUT,
   * exit(1) — before the healthcheck port was ever open. The platform restarted
   * it, the same race lost again, and after enough rounds the deploy was marked
   * crashed. The database was fine; it was simply a few seconds behind.
   *
   * Opening the port first means the healthcheck passes while the schema is
   * still being applied. A request that arrives in that window hits a table that
   * does not exist yet, which the /accept handler already turns into a 503 —
   * and 503 is precisely the code the client keeps its payload for and retries.
   * So the degraded window costs an acceptance nothing.
   */
  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    // A port we cannot bind is not a waiting game; nothing will fix it.
    app.log.error({ err }, "could not bind port");
    process.exit(1);
  }

  /*
   * Apply the schema with bounded exponential backoff.
   *
   * Retrying rather than exiting because the overwhelmingly likely cause of a
   * failure here is "Postgres is not up yet", which resolves itself in seconds.
   * The cap is ~5 minutes total; past that the failure is structural — a wrong
   * DATABASE_URL, a deleted database — and continuing to hammer it neither
   * fixes it nor surfaces it. The process stays alive either way so /health
   * keeps answering and the logs stay readable.
   */
  void (async () => {
    const MAX_ATTEMPTS = 12;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await migrate();
        ready = true;
        app.log.info({ attempt }, "schema applied; ready to record acceptances");
        return;
      } catch (err) {
        if (attempt === MAX_ATTEMPTS) {
          app.log.error({ err, attempt, why: describeConnectError(err) },
            "schema could not be applied; /accept will keep returning 503 and clients will keep retrying");
          return;
        }
        const waitMs = Math.min(30_000, 500 * 2 ** (attempt - 1));
        app.log.warn({ attempt, waitMs, why: describeConnectError(err) },
          "database not reachable yet; retrying");
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  })();

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => {
      await app.close().catch(() => {});
      await closePool().catch(() => {});
      process.exit(0);
    });
  }
}

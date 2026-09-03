// Verify (acceptance server): the endpoint records what it should, refuses what
// it should, and never loses a record it could have kept.
//
// The database is stubbed throughout. What is under test is the contract the
// client depends on — which status code means "stop retrying" and which means
// "keep the payload and come back" — because getting that backwards is how an
// acceptance silently disappears.

import { buildServer, resetRateLimitForTests } from "../src/server.js";
import { validateAcceptance } from "../src/validate.js";

let fails = 0;
const ok = (n, c, extra = "") => {
  console.log(`${c ? "PASS" : "FAIL"} ${n}${extra ? ` — ${extra}` : ""}`);
  if (!c) fails++;
};

// The shape acceptance.js has written as `machine` since v1.3.0.
const INSTALL_ID = "9f86d081884c7d659a2feaa0c55ad015";
const SHA = "a".repeat(64);
const good = () => ({
  installId: INSTALL_ID,
  termsVersion: "v2",
  termsSha256: SHA,
  appVersion: "1.4.0",
  acceptedAt: "2026-08-31T12:41:00.000Z",
});

// --- 1. validation accepts what it should -----------------------------------
{
  const r = validateAcceptance(good());
  ok("a well-formed payload validates", r.ok);
  ok("...and keeps the install id", r.value?.installId === INSTALL_ID);
  ok("...and the checksum", r.value?.termsSha256 === SHA);
  ok("...with no email when none was given", r.value?.email === null);
}

// --- 2. validation refuses what it should -----------------------------------
{
  const bad = (patch, label) => {
    const r = validateAcceptance({ ...good(), ...patch });
    ok(`rejects ${label}`, r.ok === false, r.ok ? "accepted!" : r.error);
  };
  bad({ installId: "not-an-id" }, "a malformed install id");
  bad({ installId: "9f86d081884c7d659a2feaa0c55ad0" }, "a too-short install id");
  bad({ installId: `${INSTALL_ID}extra` }, "an over-long install id");
  bad({ installId: "z".repeat(32) }, "a non-hex install id");
  bad({ termsSha256: "abc" }, "a short checksum");
  bad({ termsSha256: "z".repeat(64) }, "a non-hex checksum");
  bad({ termsVersion: "version two" }, "a prose version");
  bad({ appVersion: {} }, "a non-string app version");
  bad({ email: "no-at-sign" }, "an email with no @");
  bad({ email: `${"x".repeat(320)}@e.com` }, "an over-long email");
  ok("rejects a non-object body", validateAcceptance("hello").ok === false);
  ok("rejects an array body", validateAcceptance([]).ok === false);
  ok("rejects null", validateAcceptance(null).ok === false);
}

// --- 3. the optional email is genuinely optional -----------------------------
{
  // Absent, null, empty and whitespace must all mean "not given" — if any of
  // them stored "" instead, the table would claim an address was volunteered
  // when it was not.
  for (const [v, label] of [[undefined, "absent"], [null, "null"], ["", "empty"], ["   ", "whitespace"]]) {
    const r = validateAcceptance({ ...good(), email: v });
    ok(`email ${label} stores nothing`, r.ok && r.value.email === null);
  }
  const r = validateAcceptance({ ...good(), email: "  Someone@Example.com  " });
  ok("a real email is trimmed and kept", r.ok && r.value.email === "Someone@Example.com");
}

// --- 4. a bad clock does not cost a real acceptance --------------------------
{
  const r = validateAcceptance({ ...good(), acceptedAt: "not a date" });
  ok("an unparseable acceptedAt is dropped, not fatal", r.ok && r.value.acceptedAt === null);
  const r2 = validateAcceptance({ ...good(), acceptedAt: 12345 });
  ok("a non-string acceptedAt is dropped, not fatal", r2.ok && r2.value.acceptedAt === null);
}

// --- 5. nothing unrecognised survives ----------------------------------------
{
  const r = validateAcceptance({ ...good(), hostname: "DOMS-PC", ip: "1.2.3.4", notes: "x" });
  ok("unknown keys are stripped", r.ok && !("hostname" in r.value) && !("ip" in r.value));
  ok("...leaving exactly the six known fields", Object.keys(r.value).length === 6, Object.keys(r.value).join(","));
}

// --- 6. the endpoint's status codes mean what the client assumes -------------
{
  const app = buildServer({ logger: false, insert: async () => ({ id: "1", created: true }) });

  const health = await app.inject({ method: "GET", url: "/health" });
  // The health route must answer TRUE while the schema is still being applied.
  // This is the bug that stopped the first deploy: migrating before listening
  // meant the process died of a slow database before the port was ever open,
  // and the platform never saw a healthy container to keep.
  {
    const booting = buildServer({ insert: async () => { throw new Error("no table yet"); },
                                  logger: false, isReady: () => false });
    const h = await booting.inject({ method: "GET", url: "/health" });
    ok("health answers ok while the schema is still pending", h.statusCode === 200);
    ok("...while reporting it is not ready yet", h.json().ready === false);

    // And an acceptance arriving in that window must be told to come back,
    // never told it succeeded and never told to give up.
    const a = await booting.inject({ method: "POST", url: "/accept", payload: good() });
    ok("...and an acceptance in that window gets a retryable 503", a.statusCode === 503);
    await booting.close();
  }

  ok("health responds", health.statusCode === 200);

  const res = await app.inject({ method: "POST", url: "/accept", payload: good() });
  ok("a good acceptance returns 200", res.statusCode === 200, String(res.statusCode));
  ok("...and reports it was created", res.json().created === true);

  const bad = await app.inject({ method: "POST", url: "/accept", payload: { installId: "nope" } });
  ok("a malformed acceptance returns 400", bad.statusCode === 400, String(bad.statusCode));

  await app.close();
}

// --- 7. a retry of an already-recorded acceptance is a success ---------------
{
  // This is the one that matters for an offline user: the client re-sends until
  // it gets a success. If "already on file" answered with an error, it would
  // re-send forever.
  const app = buildServer({ logger: false, insert: async () => ({ id: "7", created: false }) });
  const res = await app.inject({ method: "POST", url: "/accept", payload: good() });
  ok("a duplicate returns 200, not an error", res.statusCode === 200, String(res.statusCode));
  ok("...and reports it was not newly created", res.json().created === false);
  await app.close();
}

// --- 8. a database failure tells the client to keep trying -------------------
{
  const app = buildServer({
    logger: false,
    insert: async () => {
      throw new Error("connection refused");
    },
  });
  const res = await app.inject({ method: "POST", url: "/accept", payload: good() });
  // 503, not 500, and specifically not 400: the client stops retrying on 4xx, so
  // answering a transient outage with a 4xx would discard a real acceptance.
  ok("a database failure returns 503", res.statusCode === 503, String(res.statusCode));
  await app.close();
}

// --- 9. rate limiting: an unauthenticated write route needs a ceiling -------
// installId proves nothing — a client-chosen value with no proof of
// ownership — so without a limit, anyone can script unlimited distinct rows.
{
  resetRateLimitForTests();
  const app = buildServer({ logger: false, insert: async () => ({ id: "r", created: true }) });

  let last = null;
  for (let i = 0; i < 20; i++) {
    last = await app.inject({ method: "POST", url: "/accept", payload: good(), remoteAddress: "203.0.113.10" });
  }
  ok("the first 20 requests from one IP within the window all succeed", last.statusCode === 200);

  const over = await app.inject({ method: "POST", url: "/accept", payload: good(), remoteAddress: "203.0.113.10" });
  ok("the 21st request from the SAME IP in the same window is refused", over.statusCode === 429);

  const other = await app.inject({ method: "POST", url: "/accept", payload: good(), remoteAddress: "203.0.113.11" });
  ok("a DIFFERENT IP is unaffected by another IP's usage", other.statusCode === 200);

  await app.close();
  resetRateLimitForTests();
}

console.log(fails === 0 ? "\nALL PASSED" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);

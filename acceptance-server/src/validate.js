// Payload validation, kept separate from both the database and the HTTP layer so
// it can be tested without either.
//
// This endpoint is public and unauthenticated — it has to be, because the client
// that calls it ships to anyone. So the validator's job is not only "is this
// well-formed" but "is this bounded": every field has a length cap, and anything
// unrecognised is dropped rather than stored. A public writer into an evidence
// table must not be a place to put arbitrary data.

// The id already written as `machine` in ~/.dom/acceptance.json since v1.3.0:
// 32 hex characters. Not a UUID, and deliberately not changed to one — reusing
// the id that already exists on users' machines is what lets a server row be
// matched against the local record, which is the entire point of keeping both.
const INSTALL_ID_RE = /^[0-9a-f]{32}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const VERSION_RE = /^v?\d+(\.\d+){0,3}$/;

/** Generous but bounded. Real addresses are far shorter; this only rejects abuse. */
const MAX_EMAIL = 320;

/**
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function validateAcceptance(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }

  const installId = body.installId;
  if (typeof installId !== "string" || !INSTALL_ID_RE.test(installId)) {
    return { ok: false, error: "installId must be 32 hex characters" };
  }

  const termsSha256 = body.termsSha256;
  if (typeof termsSha256 !== "string" || !SHA256_RE.test(termsSha256)) {
    return { ok: false, error: "termsSha256 must be 64 hex characters" };
  }

  const termsVersion = body.termsVersion;
  if (typeof termsVersion !== "string" || !VERSION_RE.test(termsVersion)) {
    return { ok: false, error: "termsVersion must look like v2" };
  }

  const appVersion = body.appVersion;
  if (typeof appVersion !== "string" || !VERSION_RE.test(appVersion)) {
    return { ok: false, error: "appVersion must look like 1.4.0" };
  }

  // The client's clock is corroboration, not evidence, so a bad value here is
  // dropped rather than treated as a failure — the server's own received_at is
  // what the record actually rests on, and refusing the whole acceptance over a
  // skewed clock would lose a real record to a cosmetic problem.
  let acceptedAt = null;
  if (typeof body.acceptedAt === "string") {
    const t = Date.parse(body.acceptedAt);
    if (Number.isFinite(t)) acceptedAt = new Date(t).toISOString();
  }

  // Optional and unverified. Absent, null, and empty all mean the same thing:
  // the user did not give one, and no column value is stored.
  let email = null;
  if (typeof body.email === "string" && body.email.trim() !== "") {
    const trimmed = body.email.trim();
    if (trimmed.length > MAX_EMAIL) {
      return { ok: false, error: "email is too long" };
    }
    // Deliberately shallow. The address is never verified or sent to, so the
    // only thing a strict pattern would achieve is rejecting a real acceptance
    // over an unusual-but-valid address.
    if (!trimmed.includes("@")) {
      return { ok: false, error: "email must contain @" };
    }
    email = trimmed;
  }

  return {
    ok: true,
    // Rebuilt field by field. Nothing the caller sent beyond these keys survives.
    value: { installId, termsVersion, termsSha256, appVersion, acceptedAt, email },
  };
}

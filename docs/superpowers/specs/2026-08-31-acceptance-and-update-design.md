# Gnosis v1.4.0 — Acceptance Record Service, Terms v2, Notify-Only Updates

**Date:** 2026-08-31
**Status:** Approved (design)

## Problem

Three related problems, all surfaced by the same incident.

1. **The acceptance record is only on the user's machine.** `~/.dom/acceptance.json`
   is checksummed and self-proving, but it lives on hardware the user controls.
   They can edit it or delete it. If someone claims they were never shown the
   Terms, there is no copy outside their reach to contradict them.

2. **Terms v1 forecloses the fix.** §5 states, verbatim, "We collect nothing. The
   Gnosis project operates no servers, no analytics, no telemetry and no
   accounts." Real users accepted v1.3.0 under that sentence. Adding a server
   without rewriting and re-presenting the Terms would make a promise already
   given to real people false — which is a worse position than having no server
   record at all.

3. **Auto-update is actively dangerous while the installer is unsigned.**
   Bitdefender flagged `Gnosis-Setup-1.2.0.exe` and `index.js` as
   `Atc4.Detection` — a generic behavioural heuristic, not a named signature —
   and quarantined them. The result on the developer machine was a deleted
   payload, a broken Start Menu shortcut, and a source file (`electron/voice.js`)
   that the on-access scanner still refuses to let anything recreate. An
   auto-update that fires this on a user's machine leaves them with a half-removed
   install and no obvious way back.

## Non-goals

- Verified identity. Unverified email is not proof; a verification-code gate is
  disproportionate for a free MIT-licensed tool and would cost most of the user
  base. See "Optional email" below for the compromise actually chosen.
- Analytics, usage metrics, crash reporting, or any recurring beacon. The service
  receives one record per acceptance and nothing else, ever.
- Code signing. It is the real fix for the antivirus problem and should happen,
  but it needs a certificate and is tracked separately. This spec makes the app
  safe *while unsigned*.

## Design

### 1. Acceptance service (`acceptance-server/`, Railway + Postgres)

A single small Fastify service living in this repo, deployed to Railway with its
root directory set to `acceptance-server/` so Railway does not attempt to build
the Electron app.

It lives in the Gnosis repo rather than its own so that `TERMS.md`, its SHA-256,
and the service that records acceptances of it are versioned in the same commit.
Drift between the recorded hash and the shipped text is the one failure mode that
would render the entire record worthless, and a single repo makes that drift
impossible to introduce accidentally.

**Endpoint:** `POST /accept`

```jsonc
// request
{
  "installId":    "<32 hex>",  // the `machine` id acceptance.js has already written
                               // to ~/.dom/acceptance.json since v1.3.0. Random,
                               // never derived from hardware, MAC or username
  "termsVersion": "v2",
  "termsSha256":  "<64 hex>",
  "appVersion":   "1.4.0",
  "acceptedAt":   "<client ISO-8601>",  // recorded, but NOT the evidentiary anchor
  "email":        "user@example.com"    // optional; omitted entirely when blank
}
```

```jsonc
// response
{ "ok": true, "id": "<server record id>" }
```

**Storage:** Railway-managed Postgres. Append-only by convention — the service
issues `INSERT` only; it exposes no update or delete path.

```sql
CREATE TABLE acceptances (
  id            BIGSERIAL PRIMARY KEY,
  install_id    TEXT        NOT NULL CHECK (install_id ~ '^[0-9a-f]{32}$'),
  terms_version TEXT        NOT NULL,
  terms_sha256  TEXT        NOT NULL,
  app_version   TEXT        NOT NULL,
  accepted_at   TIMESTAMPTZ,           -- client-claimed, untrusted
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),  -- server truth
  email         TEXT                   -- nullable
);
CREATE INDEX ON acceptances (install_id);
CREATE UNIQUE INDEX ON acceptances (install_id, terms_sha256);
```

**The server timestamps.** `received_at` is set by Postgres, not the client. A
client-supplied time is trivially forged, so `accepted_at` is retained only as a
corroborating detail and is never relied on alone.

**Idempotency.** The unique index on `(install_id, terms_sha256)` makes retries
safe: a duplicate POST conflicts and returns the existing record rather than
creating a second row. This matters because the client retries until confirmed.

**No IP retention.** Railway terminates TLS and will log request IPs at the edge
as any host does, but the service neither reads nor stores the IP. Nothing in the
table can be resolved to a location or a person absent a volunteered email.

### 2. Client changes

**Install ID.** Reuses the `machine` id that `acceptance.js` has already written
into `~/.dom/acceptance.json` since v1.3.0 — 32 random hex characters, seeded
from the clock and a random number, never derived from hardware serial, MAC
address, hostname or username. It identifies an *installation*, not a machine or
a person, and reinstalling produces a new one.

Reusing it rather than minting a UUID is deliberate: the whole value of the
server copy is that it can be matched against the local record, and a second
identifier in a different format would orphan every record written before this
table existed.

**Offline must never block acceptance.** The local record stays authoritative for
gating the welcome window. The server call is fire-and-forget: on acceptance the
client writes the local record first (unchanged from today), then attempts the
POST. On failure the payload is queued to `~/.dom/acceptance-queue.json` and
retried on subsequent launches until the server confirms. Without the queue,
anyone who installs offline is silently never recorded, which would quietly
hollow out the whole mechanism.

**Optional email.** The welcome window gains one optional field, labelled as
optional, with a plain sentence saying what it is for. Blank is the default and
blank omits the key from the payload entirely. It is unverified and the spec
treats it as soft corroboration only.

**Disclosure precedes transmission.** Nothing is sent for a user who has not yet
accepted v2. The welcome window states, on screen and before the Accept button,
that accepting sends the record. A user still on v1 terms who never accepts v2
transmits nothing, ever.

### 3. Terms v2

`TERMS.md` goes to **Version 2**. Required edits:

- **§5** — the "We collect nothing" paragraph is rewritten. The new text states
  plainly that one record is sent when the Terms are accepted, lists exactly the
  fields, says the email is optional and unverified, and states that no other
  data is ever transmitted to the project. The service is added as a row in the
  existing services table.
- **§11** — updated to say the record is kept both locally and on the project's
  server, and to describe how to request deletion of a volunteered email.
- **Header** — Version 2, new effective date.

Because §11 of v1 already promises "material changes are presented for acceptance
again when you update", and `welcome.js` gates on a major/minor version
comparison, existing v1.3.0 users are re-prompted automatically on upgrade. That
promise is kept without additional work — but it must be verified by test, not
assumed.

### 4. Notify-only updates

`electron/updater.js` changes from download-and-stage to notify-only.

- `autoDownload = false` — the installer is never fetched. This is deliberate and
  goes further than disabling install: Bitdefender quarantined
  `Gnosis-Setup-1.2.0.exe` itself, so merely *having* the file on disk is enough
  to trigger the detection. Downloading it and declining to run it would still
  produce the quarantine pop-up and the "threat detected" alarm.
- `autoInstallOnAppQuit = false` — nothing to install, nothing to stage.
- On `update-available`, show an in-app toast **and** a native OS notification
  saying a newer version exists, with an action that opens the GitHub releases
  page in the browser. The user downloads and installs deliberately, at a moment
  of their choosing, when an antivirus prompt is comprehensible rather than
  mysterious.
- The six-hour re-check loop is retained. It is one HTTPS metadata request and it
  is what makes the reminder timely.

This trades silent updates for reliability, which is the correct trade while the
installer is unsigned: a user who ignores a reminder is on an old build, whereas
a user whose antivirus interrupts a background install is on a *broken* one.

Once the installer is code-signed, `autoDownload` can be reconsidered. That
decision belongs to the signing work, not here.

## Error handling

| Failure | Behaviour |
| --- | --- |
| Server unreachable at acceptance | Local record written; payload queued; user sees nothing; retried next launch |
| Server returns 5xx | Same as unreachable — queued and retried |
| Server returns 4xx (malformed) | Logged; not retried indefinitely; never surfaced to the user |
| Duplicate POST | Unique index conflicts; existing row returned; queue entry cleared |
| Local record write fails | Existing behaviour retained — the user is not trapped in the window |
| Update check fails | Silent, as today. Normal when offline |

No server failure is ever allowed to block, delay, or interrupt acceptance. The
user's ability to use the software they installed does not depend on the
project's infrastructure being up.

## Testing

- `acceptance-server` — unit tests for the insert path, the idempotency conflict,
  rejection of malformed payloads, and confirmation that `received_at` is
  server-set and a forged `acceptedAt` does not override it.
- Client — the queue survives a failed POST and drains on the next launch; a
  blank email is omitted from the payload rather than sent as `""`; nothing is
  transmitted before acceptance.
- Terms — the shipped `TERMS.md` hashes to the value the client records; a v1.3.0
  config is re-prompted by `significantlyNewer`.
- Updater — asserts `autoDownload === false` and `autoInstallOnAppQuit === false`,
  so a future edit cannot silently restore background downloading.

## Open items

- **Code signing.** The real fix for the antivirus false positives. Tracked
  separately; a SignPath.io open-source tier may apply given the repo is public.
- **False-positive submissions** to Bitdefender and Microsoft Defender for the
  current hashes — useful stopgap, invalidated by each new build.
- **`electron/voice.js`** is currently deleted on the dev machine and the
  on-access scanner refuses to let it be recreated. It is intact in git. Needs a
  Bitdefender folder exception on the repo before the tree is clean.

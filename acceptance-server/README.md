# Gnosis acceptance server

Records Terms of Use acceptances somewhere the accepting user cannot edit them.

## Why it exists

`~/.dom/acceptance.json` on the user's machine is checksummed and self-proving,
but its custodian is its subject. If someone says they were never shown the
Terms, a record they could have edited does not contradict them. This service
holds the same facts under a different custodian, and that is the whole point.

It is **not** analytics. The client calls it exactly once per accepted document
and never again — no heartbeat, no usage events, no second call of any kind. The
Terms promise that, so this code has to mean it.

## What it stores

| Column | Notes |
| --- | --- |
| `install_id` | Random v4 UUID, generated on first run. Identifies an *installation*. Never derived from a serial number, MAC, hostname or username |
| `terms_version` | e.g. `v2` |
| `terms_sha256` | Checksum of the exact bytes displayed. This is what makes the row evidence |
| `app_version` | e.g. `1.4.0` |
| `accepted_at` | Client-claimed. Corroboration only, never trusted alone |
| `received_at` | Set by Postgres. The evidentiary anchor |
| `email` | Optional, volunteered, **unverified**. Usually `NULL` |

No IP address is read or stored. Nothing here resolves to a person absent a
volunteered email.

## API

### `POST /accept`

```jsonc
{
  "installId":    "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  "termsVersion": "v2",
  "termsSha256":  "<64 hex>",
  "appVersion":   "1.4.0",
  "acceptedAt":   "2026-08-31T12:41:00.000Z",
  "email":        "optional@example.com"   // omit entirely if not given
}
```

Status codes are a contract the client depends on:

| Code | Meaning | Client behaviour |
| --- | --- | --- |
| `200` | Recorded, or already on file | Clear the queued payload |
| `400` | Malformed | Stop retrying — resending will not fix it |
| `503` | Transient failure | Keep the payload, retry next launch |

Answering a transient outage with a `4xx` would silently discard a real
acceptance, which is why the failure path returns `503` specifically.

### `GET /health`

`{ "ok": true }`. Used by Railway's healthcheck.

## Deploying to Railway

1. Create a Railway project and add the **Postgres** plugin. It sets
   `DATABASE_URL` automatically.
2. Add a service from this repo and set its **root directory** to
   `acceptance-server/` — otherwise Railway will try to build the Electron app.
3. Deploy. The schema is applied on boot; `npm run migrate` does it standalone.
4. Note the public URL and set `GNOSIS_ACCEPTANCE_URL` in the client build.

## Local development

```sh
npm install
npm test                    # no database needed — the store is stubbed
DATABASE_URL=postgres://localhost/gnosis npm run migrate
DATABASE_URL=postgres://localhost/gnosis npm start
```

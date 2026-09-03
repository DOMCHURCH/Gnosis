// Postgres access for the acceptance log.
//
// The pool is created lazily so the module can be imported by tests that never
// touch a database.

import pg from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

let pool = null;

/** The connection pool, created on first use. */
export function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set — Railway provides this from the Postgres plugin");
  }
  pool = new pg.Pool({
    connectionString,
    // Railway's managed Postgres presents a certificate that does not chain to a
    // public root, so rejectUnauthorized would fail every connection outright.
    //
    // Checked, not assumed, before leaving this in place: production's
    // DATABASE_URL host is `postgres.railway.internal` — Railway's private
    // network DNS, which only resolves inside this project's own private
    // network and is never reachable from the public internet at all. Per
    // Railway's own docs (docs.railway.com/guides/private-networking), ALL
    // inter-service traffic on that private network — this connection
    // included — is independently WireGuard-encrypted at the network layer,
    // beneath and regardless of whatever Postgres's own TLS is doing. So the
    // realistic MITM surface for `rejectUnauthorized: false` here is not "the
    // internet"; it is "someone already inside Railway's own control plane or
    // this project's private network", a threat model chain verification
    // against Postgres's own cert would not meaningfully add to anyway.
    //
    // What was NOT confirmed, and is not claimed: whether Railway issues a
    // customer-obtainable CA certificate for an internal Postgres endpoint
    // that could be pinned instead of disabling verification outright.
    // Railway's docs don't cover it and this was not guessed at; if that
    // matters more precisely than the above, ask Railway support directly
    // rather than trust a fabricated pin here.
    ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false },
    max: 5,
  });
  return pool;
}

/** Apply the schema. Safe to run repeatedly — every statement is IF NOT EXISTS. */
export async function migrate() {
  const sql = readFileSync(path.join(here, "..", "migrations", "001_init.sql"), "utf8");
  await getPool().query(sql);
}

/**
 * Record one acceptance.
 *
 * Returns { id, created } — created:false means this exact acceptance was
 * already on file and the row was left alone. The client retries until it gets
 * a success, so "already recorded" has to be a success rather than an error, or
 * an offline user would retry forever against a row that already exists.
 */
export async function insertAcceptance(rec) {
  const { rows } = await getPool().query(
    `INSERT INTO acceptances
       (install_id, terms_version, terms_sha256, app_version, accepted_at, email)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (install_id, terms_sha256) DO NOTHING
     RETURNING id`,
    [rec.installId, rec.termsVersion, rec.termsSha256, rec.appVersion, rec.acceptedAt ?? null, rec.email ?? null],
  );

  if (rows.length > 0) return { id: String(rows[0].id), created: true };

  // DO NOTHING returns no row on conflict, so fetch the one already there.
  const existing = await getPool().query(
    `SELECT id FROM acceptances WHERE install_id = $1 AND terms_sha256 = $2`,
    [rec.installId, rec.termsSha256],
  );
  return { id: String(existing.rows[0].id), created: false };
}

/** Close the pool. Used by tests and by graceful shutdown. */
export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

-- The acceptance record, kept where the accepting user cannot reach it.
--
-- The local copy in ~/.dom/acceptance.json is checksummed and self-proving, but
-- it sits on hardware its subject controls. This table is the independent copy:
-- same facts, different custodian. That difference is the entire reason it
-- exists.

CREATE TABLE IF NOT EXISTS acceptances (
  id            BIGSERIAL   PRIMARY KEY,

  -- Identifies an INSTALLATION, not a machine and not a person. This is the same
  -- random id already stored as `machine` in ~/.dom/acceptance.json since v1.3.0
  -- — 32 hex characters, seeded from the clock and a random number, never
  -- derived from a serial number, MAC address, hostname or username. A derived
  -- value would be a device fingerprint wearing a random id's clothes, and the
  -- Terms promise it is not one.
  --
  -- TEXT rather than UUID because that is the format that already exists on
  -- users' machines. Minting a second identifier in UUID form would orphan every
  -- local record written before this table existed, and correlating the two
  -- copies is the reason both are kept.
  install_id    TEXT        NOT NULL CHECK (install_id ~ '^[0-9a-f]{32}$'),

  terms_version TEXT        NOT NULL,

  -- The checksum of the exact bytes displayed. This, not terms_version, is what
  -- makes the row evidence: a version string cannot distinguish the text that
  -- was shown from the text that is in the repo now.
  terms_sha256  TEXT        NOT NULL,

  app_version   TEXT        NOT NULL,

  -- What the client claimed. Retained as corroboration and never trusted alone:
  -- a clock on someone else's computer is not evidence of anything.
  accepted_at   TIMESTAMPTZ,

  -- What the server observed. This is the evidentiary anchor, set by the
  -- database rather than by anything the client can influence.
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Volunteered, optional, and UNVERIFIED. Soft corroboration only; nothing in
  -- the system treats it as proof of identity, because anyone can type anything.
  -- NULL is the normal case.
  email         TEXT
);

CREATE INDEX IF NOT EXISTS acceptances_install_id_idx
  ON acceptances (install_id);

-- Makes retries safe. The client re-sends a queued acceptance on every launch
-- until the server confirms it, so without this a user who was offline for a
-- week would accumulate a row per launch and the log would say they accepted the
-- same terms fifty times. One acceptance of one document is one row.
CREATE UNIQUE INDEX IF NOT EXISTS acceptances_install_terms_uniq
  ON acceptances (install_id, terms_sha256);

// The record of who accepted which terms, and when.
//
// A disclosure nobody can prove was shown is decoration. This writes an
// append-only record to ~/.dom/acceptance.json every time someone accepts, and
// the two fields that make it worth anything are the CHECKSUM and the TEXT.
//
// The checksum is of the exact bytes the user was shown. Without it the record
// says "they agreed to the terms" while the terms sit in a file that has been
// edited since — which proves nothing, because the version number alone cannot
// distinguish the text that was displayed from the text that is there now. With
// it, the document can be shown to hash to the recorded value or it cannot.
//
// A copy of the text itself is stored alongside for the same reason: a checksum
// is only useful if the original still exists to check against, and TERMS.md
// travels with the app, not with the user's records.
//
// WHAT THIS IS NOT. It is a record on the user's own machine, which means the
// user can edit or delete it. That is unavoidable without a server, and a server
// is the one thing these terms promise not to run — collecting acceptance
// centrally would mean collecting identifiable data about every install, which
// would make the "we collect nothing" clause false. This is the strongest record
// available that does not contradict the document it is recording. Local
// acceptance records are what desktop software normally relies on.

import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Where the record lives. Beside the config, in the app's own state directory. */
export function acceptancePath() {
  return path.join(os.homedir(), ".dom", "acceptance.json");
}

/** TERMS.md, wherever it ended up for this build. */
function termsFile() {
  // Packaged builds keep the repo layout inside the asar, so ../TERMS.md holds
  // in both cases; the extra candidates cover a flattened resource layout.
  const tries = [
    path.join(here, "..", "TERMS.md"),
    path.join(here, "TERMS.md"),
    path.join(process.resourcesPath ?? "", "TERMS.md"),
  ];
  for (const p of tries) {
    try {
      const text = readFileSync(p, "utf8");
      if (text.trim()) return { path: p, text };
    } catch {
      /* try the next */
    }
  }
  return null;
}

/** The terms as shown, with their identity. */
export function loadTerms() {
  const f = termsFile();
  if (!f) return null;
  const version = /^\*\*Version (\d+)/m.exec(f.text)?.[1] ?? "1";
  return {
    text: f.text,
    version: `v${version}`,
    // sha256 of the exact bytes shown. Recorded on acceptance and re-checked on
    // every launch, so an edit to the document is detectable rather than silent.
    sha256: createHash("sha256").update(f.text, "utf8").digest("hex"),
  };
}

/** Read the existing record. Missing or unreadable → null, never throws. */
export async function readAcceptance() {
  try {
    const raw = await fs.readFile(acceptancePath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Has this exact document already been accepted?
 *
 * Compares the CHECKSUM, not the version string. A version number can be left
 * unchanged while the text is edited — deliberately or by accident — and in that
 * case the user has not seen what they are recorded as having agreed to. Any
 * change to the bytes means it has to be shown again.
 */
export async function isAccepted(terms) {
  if (!terms) return true; // no terms shipped: nothing to withhold the app for
  const rec = await readAcceptance();
  if (!rec) return false;
  const entries = Array.isArray(rec.accepted) ? rec.accepted : [];
  return entries.some((e) => e && e.sha256 === terms.sha256);
}

/**
 * Record an acceptance. Append-only: every acceptance is kept, so a history of
 * which document was agreed to and when survives later updates.
 *
 * `machine` is a random per-install id, not anything derived from the user. It
 * exists to tell two installs apart in a support conversation, and deliberately
 * carries no name, no hostname, no serial and nothing that could identify a
 * person — a record that has to be defensible must not itself be the privacy
 * problem the document promises to avoid.
 */
export async function recordAcceptance(terms, appVersion) {
  if (!terms) return null;
  const prev = (await readAcceptance()) ?? {};
  const machine =
    typeof prev.machine === "string" && prev.machine.length === 32
      ? prev.machine
      : createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 32);

  const entry = {
    termsVersion: terms.version,
    sha256: terms.sha256,
    appVersion: String(appVersion ?? "unknown"),
    acceptedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
  };

  const record = {
    machine,
    // The full text of the most recently accepted document, so the checksum can
    // still be verified on a machine that no longer has that build installed.
    termsText: terms.text,
    accepted: [...(Array.isArray(prev.accepted) ? prev.accepted : []), entry],
  };

  await fs.mkdir(path.dirname(acceptancePath()), { recursive: true }).catch(() => {});
  await fs.writeFile(acceptancePath(), JSON.stringify(record, null, 2) + "\n", "utf8");
  return entry;
}

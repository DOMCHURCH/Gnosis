// Verify (acceptance reporting + update policy): the server copy is made, is
// never allowed to cost anything, and the updater does not download.
//
// The reporting half is guarded by three properties, and each one is a way the
// feature could quietly become dishonest or destructive:
//
//   - a blank email must store NOTHING. Sending "" would record that an address
//     was volunteered when it was not, which is a false entry in the one table
//     whose entire purpose is being true.
//   - a transient failure must QUEUE, not vanish. Otherwise everyone who
//     installs offline is silently never recorded and the mechanism hollows out
//     while appearing to work.
//   - a rejected payload must be DROPPED. A queue that retries a malformed
//     record forever is a queue that never empties.
//
// The updater half pins autoDownload off. That is not a preference: an unsigned
// installer sitting in %TEMP% is what antivirus quarantines, and a silent
// background download turns that into a broken install the user cannot explain.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(path.join(root, ...p), "utf8");

// Isolate the home directory and configure an endpoint BEFORE importing the
// module under test — both are read at module load.
const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-report-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;
process.env.GNOSIS_ACCEPTANCE_URL = "https://test.invalid/accept";

const rep = await import(pathToFileURL(path.join(root, "electron", "acceptance-report.js")).href);

let fails = 0;
const ok = (n, c, extra = "") => {
  console.log(`${c ? "PASS" : "FAIL"} ${n}${extra ? ` — ${extra}` : ""}`);
  if (!c) fails++;
};

const MACHINE = "9f86d081884c7d659a2feaa0c55ad015";
const entry = () => ({
  termsVersion: "v2",
  sha256: "b".repeat(64),
  appVersion: "1.4.0",
  acceptedAt: "2026-08-31T12:41:00.000Z",
});

/** A fetch stub that answers with one status, and records what it was sent. */
const stub = (status) => {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (status === "throw") throw new Error("offline");
    return { status };
  };
  fn.calls = calls;
  return fn;
};

const readQueue = async () => {
  try {
    return JSON.parse(await fs.readFile(rep.queuePath(), "utf8"));
  } catch {
    return [];
  }
};
const clearQueue = () => fs.rm(rep.queuePath(), { force: true }).catch(() => {});

// --- 1. the endpoint is configured in this run ------------------------------
{
  ok("an endpoint override is honoured", rep.isConfigured() === true);
}

// --- 2. the payload mirrors the local record --------------------------------
{
  const p = rep.buildPayload({ machine: MACHINE, entry: entry(), email: null });
  ok("the install id is the local machine id", p.installId === MACHINE);
  ok("...the checksum comes from the local entry", p.termsSha256 === entry().sha256);
  ok("...the terms version too", p.termsVersion === "v2");
  ok("...and the app version", p.appVersion === "1.4.0");
}

// --- 3. a blank email stores nothing ----------------------------------------
{
  for (const [v, label] of [[null, "null"], [undefined, "absent"], ["", "empty"], ["   ", "whitespace"]]) {
    const p = rep.buildPayload({ machine: MACHINE, entry: entry(), email: v });
    ok(`email ${label} is omitted entirely`, !("email" in p));
  }
  const p = rep.buildPayload({ machine: MACHINE, entry: entry(), email: "  Me@Example.com " });
  ok("a real email is trimmed and included", p.email === "Me@Example.com");
}

// --- 4. status codes are mapped to the right consequence --------------------
{
  const p = rep.buildPayload({ machine: MACHINE, entry: entry(), email: null });
  ok("200 means sent", (await rep.postOnce(p, stub(200))) === "sent");
  ok("400 means drop — resending cannot help", (await rep.postOnce(p, stub(400))) === "drop");
  ok("422 means drop", (await rep.postOnce(p, stub(422))) === "drop");
  ok("503 means retry", (await rep.postOnce(p, stub(503))) === "retry");
  ok("500 means retry", (await rep.postOnce(p, stub(500))) === "retry");
  ok("a thrown request means retry", (await rep.postOnce(p, stub("throw"))) === "retry");
}

// --- 5. a failure queues, and a success does not ----------------------------
{
  await clearQueue();
  const p = rep.buildPayload({ machine: MACHINE, entry: entry(), email: null });

  await rep.report(p, stub(200));
  ok("a successful report queues nothing", (await readQueue()).length === 0);

  await rep.report(p, stub(503));
  const q = await readQueue();
  ok("a transient failure is queued", q.length === 1);
  ok("...with the payload intact", q[0]?.payload?.installId === MACHINE);

  // The same acceptance arriving twice must not become two queue entries, or an
  // offline user accumulates one per launch.
  await rep.report(p, stub(503));
  ok("the same acceptance is not queued twice", (await readQueue()).length === 1);

  await clearQueue();
  await rep.report(p, stub(400));
  ok("a rejected payload is not queued at all", (await readQueue()).length === 0);
}

// --- 6. the queue drains, and gives up eventually ---------------------------
{
  await clearQueue();
  const p = rep.buildPayload({ machine: MACHINE, entry: entry(), email: null });

  await rep.report(p, stub(503));
  const sender = stub(200);
  const r = await rep.drainQueue(sender);
  ok("a queued acceptance is re-sent on the next launch", r.sent === 1, JSON.stringify(r));
  ok("...and leaves the queue empty", (await readQueue()).length === 0);
  ok("...having actually posted it", sender.calls.length === 1);

  // Still failing: kept, with the attempt counted.
  await rep.report(p, stub(503));
  const r2 = await rep.drainQueue(stub(503));
  ok("a still-failing acceptance is kept", r2.kept === 1);
  ok("...with the attempt counted", (await readQueue())[0]?.attempts === 2);

  // A payload the server keeps refusing is dropped rather than retried forever.
  await fs.writeFile(rep.queuePath(), JSON.stringify([{ payload: p, attempts: 59 }]), "utf8");
  const r3 = await rep.drainQueue(stub(503));
  ok("a payload past the attempt limit is dropped", r3.dropped === 1 && r3.kept === 0, JSON.stringify(r3));
  ok("...leaving the queue empty", (await readQueue()).length === 0);

  // A corrupt entry must not wedge the drain for everything behind it.
  await fs.writeFile(rep.queuePath(), JSON.stringify([{ nonsense: true }, { payload: p }]), "utf8");
  const r4 = await rep.drainQueue(stub(200));
  ok("a corrupt queue entry is discarded, not fatal", r4.sent === 1, JSON.stringify(r4));
}

// --- 7. nothing is sent before acceptance -----------------------------------
{
  // Source-level, because the property is "no other code path calls this". The
  // only callers may be the accept handler and the launch-time drain.
  const w = read("electron", "welcome.js");
  ok("the report is made from the accept handler", /report\(buildPayload\(/.test(w));
  ok("...after the local record is written",
    w.indexOf("recordAcceptance(terms, version)") < w.indexOf("report(buildPayload("));

  const main = read("electron", "main.js");
  ok("the queue is drained at launch", /drainQueue\(\)/.test(main));

  const callers = ["welcome.js", "main.js"];
  const others = ["settings.js", "voice.js", "tray.js", "updater.js"].filter((f) => {
    try {
      return /acceptance-report/.test(read("electron", f));
    } catch {
      return false; // not present on this machine; not a caller either way
    }
  });
  ok("no other module reports acceptances", others.length === 0,
    others.length ? others.join(", ") : `only ${callers.join(" and ")}`);
}

// --- 8. the updater checks, and does not download ---------------------------
{
  const u = read("electron", "updater.js");
  // The three lines that decide whether an antivirus false positive can break a
  // user's install without them doing anything.
  ok("autoDownload is off", /autoUpdater\.autoDownload = false/.test(u));
  ok("autoInstallOnAppQuit is off", /autoUpdater\.autoInstallOnAppQuit = false/.test(u));
  ok("nothing calls quitAndInstall", !/quitAndInstall/.test(u));
  ok("...and checkForUpdatesAndNotify is not used", !/checkForUpdatesAndNotify\(/.test(u));

  ok("it still checks for updates", /autoUpdater\.checkForUpdates\(\)/.test(u));
  ok("...and still re-checks periodically", /SIX_HOURS/.test(u));
  ok("it tells the user with a native notification", /new Notification\(/.test(u));
  ok("...and sends them to the releases page", /releases\/latest/.test(u));
  ok("...without re-notifying for a version already announced", /notifiedVersion/.test(u));
  ok("the reason is recorded for whoever reverts this", /code-signed/.test(u));

  // The renderer must not still offer a restart that cannot do anything.
  const pre = read("electron", "shell-preload.cjs");
  ok("the preload no longer exposes restartToUpdate", !/restartToUpdate/.test(pre));
  ok("...and exposes the releases page instead", /openReleasesPage/.test(pre));

  const toast = read("web", "src", "UpdateToast.tsx");
  ok("the toast listens for available, not ready", /onUpdateAvailable/.test(toast) && !/onUpdateReady/.test(toast));
  ok("...and its button opens the releases page", /openReleasesPage\(\)/.test(toast));
}

// --- 9. the window discloses the server copy before the button --------------
{
  const html = read("electron", "welcome.html");
  ok("the window mentions the copy sent to the project", /sent to the Gnosis project/i.test(html));
  ok("...says it happens once", /once, when\s*\n?\s*you press the button/i.test(html));
  ok("...and that nothing else follows", /No prompts, no files, no usage/i.test(html));
  ok("the email field is marked optional", /<strong>optional<\/strong>/.test(html));
  ok("...and a blank one is not sent", /email \|\| null/.test(html));
  ok("...and it is only shown when a real endpoint exists", /info\?\.reporting/.test(html));
  ok("the old 'this computer only' claim is gone", !/this computer only/.test(html));
}

try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

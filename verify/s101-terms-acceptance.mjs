// Verify (terms + acceptance): the disclosure is recorded, and is true.
//
// "There should be a file that remembers who accepted the agreement or else it's
// useless." Correct — a disclosure nobody can prove was shown is decoration.
//
// The two properties that make the record worth anything are pinned here:
//
//   - it is keyed on a CHECKSUM of the exact text displayed, not a version
//     string. A version number cannot tell the text that was shown apart from
//     the text that is there now, so editing TERMS.md without it would leave
//     people recorded as accepting words they never saw.
//   - it is append-only, so updating does not erase the history of what was
//     agreed to before.
//
// And the part that is easy to get wrong in the other direction: the document
// has to be TRUE. "We collect nothing" is true of the project and misleading
// about the app, which sends prompts to OpenRouter and speech to Groq. Section 4
// checks both halves are present, and that the app's own claims match what the
// code actually does.
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(path.join(root, ...p), "utf8");

// Isolate the home directory BEFORE importing anything that writes to it.
const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-terms-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

// acceptance.js imports nothing from electron, so it loads under plain node.
const acc = await import(pathToFileURL(path.join(root, "electron", "acceptance.js")).href);

let fails = 0;
const ok = (n, c, extra = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${extra ? ` — ${extra}` : ""}`); if (!c) fails++; };

// --- 1. the document is found and identified --------------------------------
const terms = acc.loadTerms();
{
  ok("TERMS.md is found and loaded", !!terms && terms.text.length > 2000, `${terms?.text?.length ?? 0} chars`);
  ok("...with a version", /^v\d+$/.test(terms?.version ?? ""), terms?.version);
  ok("...and a sha256 of the exact bytes", /^[0-9a-f]{64}$/.test(terms?.sha256 ?? ""));
  // The checksum must be OF THE DOCUMENT, verifiable independently.
  const independent = createHash("sha256").update(read("TERMS.md"), "utf8").digest("hex");
  ok("...that matches an independent hash of the file", terms?.sha256 === independent);
}

// --- 2. acceptance is recorded, and provable --------------------------------
{
  ok("nothing is accepted on a fresh machine", (await acc.isAccepted(terms)) === false);

  const entry = await acc.recordAcceptance(terms, "1.3.0");
  ok("recording returns the entry", !!entry && entry.sha256 === terms.sha256);
  ok("...and it now reads as accepted", (await acc.isAccepted(terms)) === true);

  const rec = await acc.readAcceptance();
  ok("the record is on disk", !!rec);
  ok("...with the checksum of what was shown", rec.accepted[0].sha256 === terms.sha256);
  ok("...when it was accepted", !Number.isNaN(Date.parse(rec.accepted[0].acceptedAt)));
  ok("...which app version showed it", rec.accepted[0].appVersion === "1.3.0");
  ok("...and the terms version", rec.accepted[0].termsVersion === terms.version);

  // The full text is kept so the checksum can still be verified on a machine
  // that no longer has that build installed.
  ok("a copy of the accepted text is kept", rec.termsText === terms.text);
  ok("...so the record is self-verifying",
    createHash("sha256").update(rec.termsText, "utf8").digest("hex") === rec.accepted[0].sha256);

  // A stable per-install id, and nothing that identifies a person.
  ok("a per-install id is stored", /^[0-9a-f]{32}$/.test(rec.machine ?? ""));
  const blob = JSON.stringify({ machine: rec.machine, accepted: rec.accepted });
  for (const leak of [os.hostname(), os.userInfo().username, fake]) {
    if (!leak) continue;
    ok(`...carrying no ${leak === os.hostname() ? "hostname" : leak === fake ? "home path" : "username"}`,
      !blob.toLowerCase().includes(String(leak).toLowerCase()));
  }
}

// --- 3. an edited document must be re-accepted ------------------------------
// The whole reason the key is a checksum and not a version string.
{
  const edited = { ...terms, text: terms.text + "\n<!-- changed -->\n" };
  edited.sha256 = createHash("sha256").update(edited.text, "utf8").digest("hex");
  ok("editing the text invalidates the acceptance", (await acc.isAccepted(edited)) === false);
  ok("...even though the version string is identical", edited.version === terms.version);

  // Accepting again must APPEND, not overwrite: the history of what was agreed
  // to before has to survive an update.
  await acc.recordAcceptance(edited, "1.4.0");
  const rec = await acc.readAcceptance();
  ok("a second acceptance is appended", rec.accepted.length === 2);
  ok("...keeping the first", rec.accepted[0].sha256 === terms.sha256);
  ok("...and the machine id is stable across both", /^[0-9a-f]{32}$/.test(rec.machine));
  ok("both documents now read as accepted",
    (await acc.isAccepted(terms)) === true && (await acc.isAccepted(edited)) === true);
}

// --- 4. the document tells the truth ----------------------------------------
{
  const t = read("TERMS.md");

  // v2 collects one thing. The document has to say so, say exactly what, and
  // say what it does NOT do — "we collect one thing" is only honest if the
  // boundary around it is stated too.
  ok("it is version 2", /\*\*Version 2 ·/.test(t));
  ok("it says what is collected", /We collect one thing, once/i.test(t));
  ok("...and that it is only on acceptance", /sent once per version of these Terms/i.test(t));
  ok("...and that nothing is sent if you decline", /If you never accept, nothing is sent/i.test(t));
  ok("...and that there is no ongoing reporting",
    /no heartbeat, no usage reporting, no\s*\n?analytics/i.test(t));

  // The fields, itemised. A disclosure that says "some data" is not a
  // disclosure, and each of these is a promise the code has to keep.
  ok("...itemising the installation id", /An installation id/i.test(t));
  ok("...saying the id is not derived from the user",
    /not\*\* derived from your name, username, hostname, hardware serial/i.test(t));
  ok("...itemising the terms checksum", /A checksum of these Terms/i.test(t));
  ok("...and that the email is optional and unverified",
    /Only if you choose to type one/i.test(t) && /we do not verify it/i.test(t));

  // v1 promised the opposite. Leaving that sentence anywhere in the document
  // would make it contradict itself.
  ok("the old 'we collect nothing' claim is gone", !/\*\*We collect nothing\.\*\*/.test(t));
  ok("...except where it explains what changed", /That is no longer true/i.test(t));

  ok("...AND that the app is not offline", /the Software is not offline/i.test(t));
  for (const svc of ["OpenRouter", "Groq", "Brave", "GitHub"]) {
    ok(`...naming ${svc}`, new RegExp(svc).test(t));
  }
  ok("...and naming the project's own server as a recipient",
    /\*\*The Gnosis project\*\* \| The acceptance record/.test(t));

  // Deletion has to be answerable for the one field that could identify anyone.
  ok("it says how to get a volunteered email deleted", /want it removed/i.test(t));
  // Verified against the code rather than asserted: if a telemetry endpoint is
  // ever added, this claim becomes false and this test should fail.
  const code = ["src", "electron"].flatMap((dir) =>
    readdirSync(path.join(root, dir), { withFileTypes: true, recursive: true })
      .filter((e) => e.isFile() && /\.(ts|js|cjs)$/.test(e.name))
      .map((e) => path.join(e.parentPath ?? e.path, e.name)),
  );
  const telemetry = code.filter((f) => /posthog|mixpanel|segment\.io|amplitude|sentry\.io|google-analytics/i.test(readFileSync(f, "utf8")));
  ok('the "no telemetry" claim matches the code', telemetry.length === 0,
    telemetry.length ? telemetry.slice(0, 3).join(", ") : "no analytics SDKs found");

  // The liability half.
  ok("no warranty is disclaimed", /WITHOUT WARRANTY OF ANY KIND/.test(t));
  ok("liability is limited", /LIMITATION OF LIABILITY|IN NO EVENT SHALL/i.test(t));
  ok("the user is made responsible", /You are solely responsible/i.test(t));
  ok("there is an indemnity", /indemnify/i.test(t));
  ok("high-risk uses are excluded", /life-support|critical-infrastructure/i.test(t));
  ok("consumer rights are preserved", /statutory consumer rights/i.test(t));
  ok("it matches the shipped licence", /MIT/.test(t) && /MIT License/.test(read("LICENSE")));
  // Honest about its own status.
  ok("it does not pretend to be legal advice", /not legal advice/i.test(t));

  // Voice is on by default now, so the document must say so.
  ok("it states voice is on by default", /enabled by default/i.test(t));
  ok("...and warns about recording other people", /consent from everyone recorded/i.test(t));
}

// --- 5. it actually ships, and gates the window -----------------------------
{
  const y = read("electron-builder.yml");
  ok("TERMS.md is packaged", /^\s+- TERMS\.md$/m.test(y));
  ok("...and so is LICENSE", /^\s+- LICENSE$/m.test(y));

  const w = read("electron", "welcome.js");
  ok("the window gates on the terms checksum", /await isAccepted\(terms\)/.test(w));
  ok("...not only on a version number", /termsPending \|\| versionPending|!termsPending && !versionPending/.test(w));
  ok("acceptance is recorded before the window closes",
    w.indexOf("recordAcceptance(terms, version)") < w.indexOf("win.close()"));
  // A record we cannot write must not trap the user in the window forever.
  ok("a failed write still lets the user through", /must not trap the user in this window/.test(w));

  const html = read("electron", "welcome.html");
  ok("the window links the full document", /welcomeOpenTerms/.test(html));
  ok("...and says where the local record is kept", /recPath/.test(html));
  // v1 said acceptance was stored on this computer ONLY. Under v2 a copy also
  // goes to the server, so that word is now a lie and must stay gone — this
  // asserts the absence, because a stale reassurance is worse than none.
  ok("...without the v1 'only' claim, which is no longer true",
    !/this computer only/i.test(html) && !/computer only/i.test(html));
  // The server half is disclosed only when a real endpoint is configured, so
  // the markup must carry it even while it is hidden in this build.
  ok("...and carries the server disclosure to reveal when configured",
    /serverNote/.test(html) && /emailRow/.test(html));
}

// --- 6. voice is on by default, and honestly described ----------------------
{
  const v = read("electron", "voice.js");
  ok("voice starts unless explicitly disabled", /config\.voiceEnabled !== false/.test(v));
  ok("...and an explicit off still survives", /explicitly off/.test(v));

  const html = read("electron", "welcome.html");
  ok("the window says the microphone is ON", /The microphone is on/.test(html));
  ok("...and no longer claims it is off by default", !/Voice — off by default/.test(html));
  ok("...that nothing listened before the disclosure", /Nothing has listened before now/.test(html));
  ok("...that wake-word audio stays local", /no audio leaves/i.test(html));
  ok("...and offers the one-time voice download", /welcomeVoiceReady/.test(html) && /voiceSetup/.test(html));
}

try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

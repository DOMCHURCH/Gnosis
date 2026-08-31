// Verify (staying current, and being told what the app does).
//
// Three problems, one theme: things the app did silently that it should have
// done visibly, or should have done and did not.
//
// 1. PEOPLE SAT ON OLD BUILDS, and were not told. The original bug was that
//    `autoInstallOnAppQuit = false` did not mean "ask first", it meant DISCARD:
//    Gnosis downloaded the update, showed a toast, and if the user closed the
//    app without clicking Restart it threw the staged build away, then
//    re-downloaded ~120MB next launch to delete it again.
//
//    That was fixed by installing on quit — and then UNFIXED deliberately, in
//    favour of not downloading at all. The installer is unsigned, and Bitdefender
//    quarantined both Gnosis-Setup-1.2.0.exe and a bundled index.js as
//    Atc4.Detection. What a silent background install produces in that case is
//    not a stale app but a broken one: a deleted payload, a shortcut pointing at
//    nothing, and no reason for the user to connect the antivirus alarm to
//    Gnosis. So the answer to "people sit on old builds" is now to TELL them, in
//    the app and in a native notification, and let them install deliberately.
//
//    What is pinned here is therefore the surviving requirement — nobody sits on
//    an old build UNAWARE — not the mechanism, which s102 owns.
//
// 2. VOICE WAS UNDISCOVERABLE. Off by default, invisible until you happen to
//    know the wake phrase. A microphone feature the user has never been told
//    about is the one that should be surfaced first, with its state.
//
// 3. NOTHING SAID WHAT LEAVES THE MACHINE. Gnosis collects nothing, but it is
//    not an offline app — prompts go to OpenRouter, speech to Groq. Saying only
//    the first half would be technically true and materially misleading.
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(path.join(root, ...p), "utf8");
const updater = read("electron", "updater.js");
const welcomeJs = read("electron", "welcome.js");
const welcomeHtml = read("electron", "welcome.html");

let fails = 0;
const ok = (n, c, extra = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${extra ? ` — ${extra}` : ""}`); if (!c) fails++; };

// --- 1. updates actually land ------------------------------------------------
{
  // Nobody sits on an old build unaware. The app checks, and when something
  // newer exists it says so in two places — the window may not be open for days
  // on a tray app, so the native notification is the one that actually lands.
  ok("an out-of-date build is detected", /autoUpdater\.on\("update-available"/.test(updater));
  ok("...and the user is told in the app", /send\("update:available"/.test(updater));
  ok("...and told by the OS as well", /new Notification\(/.test(updater));
  ok("...and pointed at where to get it", /releases\/latest/.test(updater));

  // Nothing yanks a live app out from under a running agent — now guaranteed by
  // there being nothing staged to install at all.
  ok("nothing is downloaded behind the user's back", /autoUpdater\.autoDownload = false/.test(updater));
  ok("...and nothing installs itself on quit", /autoUpdater\.autoInstallOnAppQuit = false/.test(updater));

  // A tray app left running for days used to check exactly once, at launch.
  ok("it re-checks while the app is open", /setInterval\(check/.test(updater));
  const hours = Number(/const SIX_HOURS = (\d+) \* 60 \* 60 \* 1000/.exec(updater)?.[1] ?? 0);
  ok("...on a sane interval", hours >= 1 && hours <= 24, `${hours}h`);
  // A tray app that cannot exit because of its own update timer is a worse bug
  // than a stale build.
  ok("the timer never holds the process open", /timer\.unref\?\.\(\)/.test(updater));
  ok("...and is cleared on quit", /before-quit[\s\S]{0,60}clearInterval\(timer\)/.test(updater));
}

// --- 2. the version it compares against is OUR version ----------------------
// app.getVersion() returns ELECTRON's version when unpackaged — it stored
// "44.0.0" in dev. Anything compared against that looks older, so the welcome
// window would never appear again, suppressed forever by a number that has
// nothing to do with this app.
{
  ok("the version comes from package.json", /package\.json/.test(welcomeJs) && /pkg\?\.version/.test(welcomeJs));
  // Scoped to the function BODY: the doc comment above it names app.getVersion()
  // while explaining why it is not trusted, and a whole-file index would match
  // that instead of the code.
  {
    const start = welcomeJs.indexOf("function gnosisVersion()");
    const body = welcomeJs.slice(start, welcomeJs.indexOf("\n}", start));
    ok("...with app.getVersion() only as a fallback",
      start !== -1 && body.indexOf("pkg?.version") !== -1 &&
      body.indexOf("pkg?.version") < body.indexOf("app.getVersion()"));
  }

  // The comparison itself.
  const src = welcomeJs.slice(welcomeJs.indexOf("function significantlyNewer"));
  const body = src.slice(0, src.indexOf("\n}") + 2);
  const fn = new Function(`${body}; return significantlyNewer;`)();
  ok("a never-accepted install shows it", fn(null, "1.2.0") === true);
  ok("...and so does a blank", fn("", "1.2.0") === true);
  ok("the same version does not show it again", fn("1.2.0", "1.2.0") === false);
  ok("a patch bump does not nag", fn("1.2.0", "1.2.7") === false);
  ok("a minor release shows it again", fn("1.2.0", "1.3.0") === true);
  ok("a major release shows it again", fn("1.2.0", "2.0.0") === true);
  // The dev-version accident must not permanently suppress it.
  ok("a bogus stored version does not suppress it forever", fn("1.2.0", "1.3.0") === true);
  ok("...and an older build does not re-show it", fn("2.0.0", "1.2.0") === false);
}

// --- 3. voice is introduced, with its real state ----------------------------
{
  ok("the window has a microphone toggle", /id="voiceToggle"/.test(welcomeHtml));
  ok("...showing whether it is on", /id="voiceState"/.test(welcomeHtml));
  ok("...and the wake phrase", /hey jarvis/.test(welcomeHtml));
  ok("...and how to turn it off again", /Esc/.test(welcomeHtml) && /turns voice off/.test(welcomeHtml));
  // It must reflect reality, not an optimistic flip: enabling voice can fail
  // (no Python, no microphone) and showing "on" anyway is the same lie the
  // diagnostics panel exists to prevent.
  ok("the toggle trusts the main process over its own optimism",
    /if \(s && typeof s\.enabled === "boolean"\) voiceOn = s\.enabled/.test(welcomeHtml));
  ok("...and says so when the wake word is not ready", /wake word is not ready/.test(welcomeHtml));
  // One code path, so this switch and Settings cannot disagree.
  ok("it uses the same IPC as the Settings switch", /window\.gnosis\.setVoiceEnabled/.test(welcomeHtml));
  ok("...rather than being handed its own handler", !/setVoiceEnabled[,)]/.test(welcomeJs));
  // The honest default. Voice is now ON by default, so this asserts the CURRENT
  // truth — the earlier version of this check pinned "off until you switch it
  // on", which the default change made false. A disclosure that describes the
  // wrong default is worse than no disclosure, so the pairing matters: whenever
  // the default moves, this line has to move with it. s101 covers the same
  // claim from the terms side.
  ok("it states the microphone is ON", /The microphone is on/.test(welcomeHtml));
  ok("...and that nothing listened before the disclosure", /Nothing has listened before now/.test(welcomeHtml));
  ok("...and that it can be switched off right there", /switch it off right here/.test(welcomeHtml));
}

// --- 4. the disclosure is true, not just reassuring -------------------------
// The easy version of this text ("we don't collect any data") is true of us and
// misleading about the app. Both halves have to be there.
{
  ok("it says we collect nothing", /collects nothing/i.test(welcomeHtml));
  ok("...and that there is no telemetry", /telemetry/i.test(welcomeHtml));
  ok("...and where data actually lives", /~\/\.dom/.test(welcomeHtml) && /~\/Gnosis/.test(welcomeHtml));

  // The half that makes it honest: it is not an offline app.
  for (const svc of ["OpenRouter", "Groq", "Brave", "GitHub"]) {
    ok(`...and names ${svc} as a recipient`, new RegExp(svc).test(welcomeHtml));
  }
  ok("...and does not claim to speak for them", /own privacy policies/i.test(welcomeHtml));

  // Responsibility, in plain words rather than buried in LICENSE.
  ok("it says what the agent can do", /run shell commands/i.test(welcomeHtml));
  ok("...including desktop control", /mouse and keyboard/i.test(welcomeHtml));
  ok("...that the user is responsible", /You are responsible/i.test(welcomeHtml));
  ok("...and that there is no warranty", /no warranty/i.test(welcomeHtml) && /MIT/.test(welcomeHtml));
  // Matching the actual licence file, rather than inventing terms.
  ok("...consistent with the shipped LICENSE", /MIT License/.test(read("LICENSE")));
}

// --- 5. it cannot lock the user out or nag forever --------------------------
{
  ok("acceptance is recorded before the window closes",
    welcomeJs.indexOf("saveConfig({ acceptedVersion: version })") < welcomeJs.indexOf("win.close()"));
  ok("the window is not modal", /modal: false/.test(welcomeJs));
  ok("...and the reason is stated", /would lock the app out/.test(welcomeJs));
  // It must never block startup.
  const main = read("electron", "main.js");
  ok("startup never waits on it", /void maybeShowWelcome\(/.test(main));
  ok("...and a failure is swallowed", /never block startup on the welcome window/.test(main));
  // Not shown on top of the boot-error window, which is its own problem to fix.
  ok("it is skipped when the boot already failed", /if \(bootFailed\) openSettings\(win\);\s*\n\s*else \{/.test(main));
}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

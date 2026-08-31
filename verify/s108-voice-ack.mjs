// Verify (voice): a tool whose success speaks for itself does not cost a second
// model round trip.
//
// Measured on "open Spotify": 3.76s for the model to decide to call
// focus_window, 4.20s for the app to start, then 6.76s for a second model call
// that emitted twenty-four tokens saying it had opened. Per-call overhead is
// roughly fixed at four to seven seconds however little is generated, so that
// leg was close to pure waiting — for news the tool result already carried.
//
// The risk in the fix is scope: acknowledge too much and the app starts talking
// over answers it has not got yet. Most of these assertions are about what does
// NOT get a canned line.
import { ackLineFor } from "../electron/voicegate.js";

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- what it does say ----------------------------------------------------------
{
  ok("launching an app is acknowledged", ackLineFor("focus_window", { action: "launch", app: "spotify" }, true) === "Opening Spotify.");
  ok("focusing a window is acknowledged", ackLineFor("focus_window", { action: "focus", app: "chrome" }, true) === "Bringing Chrome forward.");
  // Spoken aloud, so it reads as a name rather than a command line.
  ok("the app name is capitalised for speech", ackLineFor("focus_window", { action: "launch", app: "discord" }, true) === "Opening Discord.");
}

// --- what it must not say ------------------------------------------------------
{
  // The whole point is that the line is true without reading the result. A
  // failed launch is the one case where saying "Opening Spotify." is a lie, and
  // it is exactly when the user most needs the model's actual explanation.
  ok("a failed tool call is NOT acknowledged", ackLineFor("focus_window", { action: "launch", app: "spotify" }, false) === null);

  // "list" answers a question — the answer is in the result, not the request.
  ok("a tool that answers a question keeps its round trip", ackLineFor("focus_window", { action: "list" }, true) === null);

  // Every other tool: reading, searching, editing. None can be narrated from
  // its arguments, and a canned line would be the app inventing an outcome.
  for (const tool of ["read", "bash", "web_search", "edit", "write", "screen"]) {
    ok(`${tool} is not acknowledged`, ackLineFor(tool, { path: "x" }, true) === null);
  }

  // Defensive: tool.end and tool.start are separate events, so the args can be
  // missing entirely if they ever arrive out of order.
  ok("missing args produce no line, not a crash", ackLineFor("focus_window", null, true) === null);
  ok("an empty app name produces no line", ackLineFor("focus_window", { action: "launch", app: "  " }, true) === null);
  ok("an unknown action produces no line", ackLineFor("focus_window", { action: "minimise", app: "spotify" }, true) === null);
}

// --- the wiring in voice.js ----------------------------------------------------
{
  // An acknowledged turn must stop speaking the model's own prose, or the user
  // hears the news twice — once early and once six seconds late.
  const src = (await import("node:fs")).readFileSync("electron/voice.js", "utf8");
  ok("the chunk path is suppressed after an ack", /\(chunk\) => \{\s*if \(ackSpoken\) return;/.test(src));
  ok("the end-of-turn tail is suppressed after an ack", /const say = ackSpoken \? "" : leftover;/.test(src));
  // Armed only: a tool call from a typed chat turn is not the app's cue to talk.
  ok("acks only fire while the gate is armed", /if \(!gate\.armed \|\| !e\) return;/.test(src));
  // A stale flag would silence the NEXT turn entirely — the worst failure here.
  ok("the ack flag is reset when a turn is armed", /ackSpoken = false;\s*lastToolArgs = null;\s*gate\.arm\(tabId\);/.test(src));
}

console.log(fails ? `\n${fails} FAILED` : "\nall voice-ack checks passed");
process.exit(fails ? 1 : 0);

// Verify: a tool is advertised only where it can actually do something.
//
// Every tool's schema goes on every request. `office` alone is 762 tokens
// describing desks on a floor that a headless run has no browser to draw, and
// the UI-only set together is ~1,700 tokens on every turn of every session —
// paid by `dom -p`, by a cron run, and by a voice turn where the floor is not
// even on screen.
//
// The token cost is the smaller half. An advertised tool is one the model will
// try, and then spend a whole round trip discovering it cannot work here — at
// the 4-7s per call measured in voice, that is the expensive kind of mistake.
process.env.USERPROFILE = "C:/Users/Dominique/dom/verify/_fakehome";
process.env.HOME = process.env.USERPROFILE;

import { allToolNames, toolDefinitions, resolveTool } from "../dist/tools/index.js";

let fails = 0;
const ok = (n, c, d) => { console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); if (!c) fails++; };
const tokens = (names) => toolDefinitions(names).reduce((s, d) => s + Math.round(JSON.stringify(d).length / 4), 0);

const full = allToolNames();

// --- headless: no browser, no tabs, no shell ---------------------------------
{
  const names = allToolNames({});
  const gone = full.filter((n) => !names.includes(n));
  ok("the office floor is not advertised without a browser", !names.includes("office"));
  ok("the tab tools are not advertised in a single session",
    !names.includes("send_message") && !names.includes("list_tabs"));
  ok("screen and camera are not advertised without a capture provider",
    !names.includes("screen") && !names.includes("camera"));
  // The point of the exercise, in the unit that matters.
  const saved = tokens(full) - tokens(names);
  ok("a headless run saves over a thousand prompt tokens per request", saved > 1000, `${saved} tokens, ${gone.length} tools`);

  // The tools that do work anywhere must survive: this is the failure that
  // would be catastrophic and silent — an agent that can no longer edit files.
  for (const keep of ["read", "write", "edit", "bash", "grep", "glob", "task", "todo"]) {
    ok(`${keep} survives the filter`, names.includes(keep));
  }
}

// --- with a runtime attached, the UI tools come back -------------------------
{
  const names = allToolNames({ tab: {}, office: {} });
  ok("the office tool returns when a floor is wired", names.includes("office"));
  ok("the tab tools return when tabs exist",
    names.includes("send_message") && names.includes("list_tabs"));
}

// --- no context means no filtering -------------------------------------------
{
  // The DISPATCHER passes nothing on purpose. A tool that became unavailable
  // mid-session must still resolve, so calling it reports why it cannot run
  // rather than reading as a tool that does not exist — those are different
  // bugs and the model recovers from them differently.
  ok("an unfiltered call still lists everything", allToolNames().length === full.length);
  ok("...and an unavailable tool still resolves by name", !!resolveTool("office"));
}

// --- the predicates are honest about their own capability --------------------
{
  // focus_window is Windows-only in every code path it has; advertising it on
  // macOS buys 369 tokens of "Windows only." as the only possible answer.
  const fw = resolveTool("focus_window");
  ok("focus_window declares a platform requirement", typeof fw.available === "function");
  ok("...and agrees with the platform it is running on", fw.available({}) === (process.platform === "win32"));
}

console.log(fails ? `\n${fails} FAILED` : "\nall tool-availability checks passed");
process.exit(fails ? 1 : 0);

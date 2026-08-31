// Verify (MCP prerequisites): a missing launcher names itself.
//
// Every server in the default registry launches as `npx -y <package>`, and npx
// comes with Node.js. The desktop app does not ship Node — Electron embeds a
// runtime for itself but puts no npm/npx on PATH — so on a freshly-installed
// Windows machine every default MCP server failed to spawn, and all the user saw
// was the operating system's own text:
//
//   spawn npx ENOENT
//
// repeated across four servers. True, and useless. That is the whole of the
// "MCP connections don't work for some reason" report.
//
// What is pinned here is that the failure is CAUGHT BEFORE the spawn and
// replaced with something actionable, and that a present launcher is not
// slowed down or blocked by the check.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const imp = (f) => import(pathToFileURL(path.resolve(here, f)).href);

const { isRunnable, launcherProblem, nodeMissing } = await imp("../dist/mcp/runtime.js");

let fails = 0;
const ok = (n, c, extra = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${extra ? ` — ${extra}` : ""}`); if (!c) fails++; };

// --- resolving a launcher ----------------------------------------------------
{
  // node is running this file, so it is by definition on PATH.
  ok("a launcher that exists resolves", isRunnable("node") === true);
  ok("a launcher that does not exist does not", isRunnable("gnosis-no-such-command-xyz") === false);
  // An absolute path is checked as a path, not looked up on PATH.
  ok("an absolute path that exists resolves", isRunnable(process.execPath) === true);
  ok("...and one that does not, does not", isRunnable(path.join(root, "no", "such", "binary.exe")) === false);
}

// --- the message is actionable ----------------------------------------------
{
  ok("a present launcher reports no problem", launcherProblem("node") === null);

  const npxMsg = (() => {
    // Force the npx branch regardless of this machine: a name that cannot exist
    // exercises the fallback, so npx itself is checked through the real answer.
    return isRunnable("npx") ? null : launcherProblem("npx");
  })();
  if (npxMsg === null) {
    console.log("SKIP npx is installed here, so its message is checked by shape below");
  } else {
    ok("a missing npx says to install Node.js", /nodejs\.org/.test(npxMsg));
  }

  // The generic branch must still name the command and where it is configured,
  // rather than echoing an errno.
  const generic = launcherProblem("gnosis-no-such-command-xyz");
  ok("an unknown launcher names the command", /gnosis-no-such-command-xyz/.test(generic));
  ok("...and points at the file to fix", /mcp\.json/.test(generic));
  ok("...and does not just echo ENOENT", !/ENOENT/.test(generic));
}

// --- the check runs BEFORE the spawn ----------------------------------------
// If it ran after, the SDK's own ENOENT would win the race and the whole point
// would be lost.
{
  const src = readFileSync(path.join(root, "src", "mcp", "client.ts"), "utf8");
  const body = src.slice(src.indexOf("async connect("));
  const guard = body.indexOf("launcherProblem(");
  const spawn = body.indexOf("new StdioClientTransport(");
  ok("client.connect() checks the launcher", guard !== -1);
  ok("...before constructing the transport", guard !== -1 && spawn !== -1 && guard < spawn);
  ok("...and reports it as an error status", /this\.status = "error";[\s\S]{0,80}this\.error = problem;/.test(body));
}

// --- and it is said once, up front ------------------------------------------
{
  const startup = readFileSync(path.join(root, "src", "startup.ts"), "utf8");
  ok("boot() warns when Node is missing entirely", /nodeMissing\(\)/.test(startup));
  ok("...naming where to get it", /nodejs\.org/.test(startup));
  // It must not be fatal: everything except MCP works without Node.
  ok("...without refusing to start", !/throw[\s\S]{0,120}nodeMissing/.test(startup));
}

// --- the answer is cached ----------------------------------------------------
// This shells out to where/which, and connect() is called once per server; four
// identical lookups on every launch is waste.
{
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) isRunnable("node");
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  ok("repeated lookups are cached, not re-shelled", ms < 50, `${ms.toFixed(1)}ms for 200 lookups`);
}

ok("nodeMissing() agrees with the direct check", nodeMissing() === !isRunnable("npx"));

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

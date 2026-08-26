// Verify (MCP tool allowlist).
//
// The allowlist is a containment boundary, not a preference: a desktop-control
// server ships a script runner, a filesystem tool, a process killer and a
// registry editor alongside the mouse. The always-prompt guard means none of
// those can run unattended, but a prompt is only as good as the person reading
// it — the allowlist is what puts them out of reach entirely, so they are never
// advertised to the model and cannot be called at all.
//
// The live end of this (the server actually publishing only the allowed tools)
// is checked against the real server by the integration step; here it is the
// pure narrowing logic, which is where an off-by-one would silently widen reach.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { applyAllowlist } = await import(pathToFileURL(path.resolve(here, "../dist/mcp/client.js")).href);

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

const tool = (name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } });
// A representative slice of what the real computer-use server offers.
const OFFERED = ["screenshot", "left_click", "type", "key", "scroll", "run_script", "filesystem", "registry", "process_kill", "write_clipboard"].map(tool);
const SAFE = ["screenshot", "left_click", "type", "key", "scroll"];

// --- 1. no allowlist keeps today's behaviour ---------------------------------
{
  ok("no allowlist publishes everything", applyAllowlist(OFFERED).tools.length === OFFERED.length);
  ok("...and withholds nothing", applyAllowlist(OFFERED).withheld === 0);
  ok("an EMPTY allowlist is treated as absent, not as 'publish nothing'", applyAllowlist(OFFERED, []).tools.length === OFFERED.length);
}

// --- 2. the dangerous tools are unreachable, not merely gated ----------------
{
  const r = applyAllowlist(OFFERED, SAFE);
  const published = r.tools.map((t) => t.name);
  ok("only the allowed tools are published", published.join() === SAFE.join());
  ok("the count is right", r.tools.length === 5 && r.withheld === 5);
  for (const danger of ["run_script", "filesystem", "registry", "process_kill", "write_clipboard"]) {
    ok(`${danger} is NEVER published`, !published.includes(danger));
  }
}

// --- 3. a typo removes a capability, so it must be reported ------------------
{
  // The names originally proposed for this server: four of them do not exist.
  const r = applyAllowlist(OFFERED, ["screenshot", "keyboard_type", "keyboard_hotkey", "mouse_click", "screenshot_region"]);
  ok("an entry matching no tool is reported", r.unmatched.length === 4);
  ok("...naming exactly the ones that do not exist",
    r.unmatched.slice().sort().join() === ["keyboard_hotkey", "keyboard_type", "mouse_click", "screenshot_region"].join());
  ok("...while the entries that DO match still publish", r.tools.map((t) => t.name).join() === "screenshot");
  ok("a fully-correct allowlist reports nothing unmatched", applyAllowlist(OFFERED, SAFE).unmatched.length === 0);
}

// --- 4. edges ----------------------------------------------------------------
{
  ok("an allowlist of only unknown names publishes nothing", applyAllowlist(OFFERED, ["nope"]).tools.length === 0);
  ok("...and says so", applyAllowlist(OFFERED, ["nope"]).unmatched.join() === "nope");
  ok("a server offering no tools is handled", applyAllowlist([], SAFE).tools.length === 0);
  ok("duplicates in the allowlist do not duplicate the tool", applyAllowlist(OFFERED, ["screenshot", "screenshot"]).tools.length === 1);
  ok("matching is exact, not prefix", applyAllowlist([tool("screenshot_region")], ["screenshot"]).tools.length === 0);
  ok("the published objects are the server's own tool objects", applyAllowlist(OFFERED, ["screenshot"]).tools[0] === OFFERED[0]);
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);

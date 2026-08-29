// Verify (app/terminal parity): every command the app OFFERS, the app ANSWERS.
//
// The Electron shell boots the same engine and points a window at the same served
// URL, so "the app is stripped down next to the terminal" was never about the
// engine — it was about this: the bridge sends the browser the full COMMANDS
// registry for autocomplete, and the serve host implemented six of them. Every
// other one the user picked out of the app's own autocomplete answered "attach a
// terminal for the full command set".
//
// So the invariant is a closed loop: advertised ⊆ answered. This drives the real
// wired bridge — the same wireServeHost the app calls — against a stub engine, and
// fails if anyone adds a command to the registry without teaching the serve host
// what to do with it.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake; process.env.HOME = fake;

const { EventBus, createBridge } = await import("../dist/events.js");
const { wireServeHost } = await import("../dist/servehost.js");
const { COMMANDS } = await import("../dist/commands.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// A stub engine: enough surface for the command handlers to read, nothing that
// reaches the network or the filesystem beyond the throwaway home.
const proj = path.join(fake, "proj");
await fs.mkdir(proj, { recursive: true });
function makeEngine(cwd = proj) {
  const e = {
    cwd, modelId: "test/model", mode: "ask", messages: [], skills: [], roots: [cwd], summary: "",
    cost: { usd: 0, promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 },
    budgetUsd: 5, budgetCeiling: 5, designMode: null, blockedCommits: new Map(),
    bus: undefined, bridge: undefined, agentId: 0, agentName: "", interactive: false,
    supportsImageInput: () => false, supportsDocumentInput: () => false,
    contextLength: () => 200000, contextTokens: () => 0, currentSystemPrompt: () => "system",
    sessionId: () => "sess-1", persist: async () => {}, clear: () => {}, abort: () => {},
    setMode(m) { this.mode = m; }, setModel(m) { this.modelId = m; },
    addRoot: () => ({ ok: true, message: cwd }), removeRoot: () => ({ ok: false, message: "no" }),
    takeOutcomeFix: () => null, forceCompact: () => {}, forceBlockedCommits: async () => [],
    adoptSession: () => {}, addNextUserImage: () => {}, setNextUserImages: () => {}, setNextUserFiles: () => {},
    fork: () => makeEngine(cwd),
  };
  return e;
}

const bus = new EventBus();
const bridge = createBridge(bus);
wireServeHost(makeEngine(), bridge);

// The lines the host emits back, per command.
const said = [];
bus.subscribe((e) => { if (e.type === "line" && e.item?.kind === "system") said.push(String(e.item.text ?? "")); });

ok("wireServeHost installs a command handler", typeof bridge.onCommand === "function");
ok("the bridge advertises the full registry", bridge.getCommands().length === COMMANDS.length);

// The exact string the old handler fell through to. Its absence IS the fix.
const OLD_REFUSAL = /isn't available in headless serve/;
const UNKNOWN = /^unknown command:/;

const refused = [];
const unknown = [];
for (const c of COMMANDS) {
  said.length = 0;
  try {
    // No args: every command must at minimum answer with its usage rather than
    // falling through. Anything that throws is a hard failure — a command that
    // crashes the handler takes the websocket message with it.
    await bridge.onCommand(0, c.name);
  } catch (e) {
    ok(`${c.name} does not throw`, false);
    console.log(`     ${e?.message ?? e}`);
    continue;
  }
  const all = said.join("\n");
  if (OLD_REFUSAL.test(all)) refused.push(c.name);
  if (UNKNOWN.test(all)) unknown.push(c.name);
}

ok("no command falls through to the headless refusal", refused.length === 0);
if (refused.length) console.log(`     still refused: ${refused.join(", ")}`);
ok("no advertised command is unknown to the handler", unknown.length === 0);
if (unknown.length) console.log(`     unknown: ${unknown.join(", ")}`);

// --- the handful that answer with a browser equivalent instead of acting -------
// These are allowed to decline, but they must name what to do instead rather than
// sending the user to a terminal.
for (const [name, expect] of [["/exit", /close the window/i], ["/alltabs", /floor view/i], ["/serve", /already serving/i]]) {
  said.length = 0;
  await bridge.onCommand(0, name);
  ok(`${name} names the browser equivalent`, expect.test(said.join("\n")));
}

// --- a few that must actually DO the thing -------------------------------------
const run = async (c) => { said.length = 0; await bridge.onCommand(0, c); return said.join("\n"); };

ok("/help renders the real registry", (await run("/help")).includes("/worktree"));
ok("/tools lists the tools", /\bbash\b/.test(await run("/tools")));
ok("/mode plan switches the mode", /mode → plan/.test(await run("/mode plan")));
ok("/context reports the window", /context: \d+ tokens/.test(await run("/context")));
ok("/cost reports spend", /\$0\.0000/.test(await run("/cost")));
ok("/budget reports the ceiling", /budget: .*ceiling/.test(await run("/budget")));
ok("/workspace lists roots", /workspace roots \(1\)/.test(await run("/workspace")));
ok("/skills says none are loaded", /no skills loaded/.test(await run("/skills")));
ok("/jobs says none are running", /no background jobs/.test(await run("/jobs")));
ok("/checkpoints says none exist", /no checkpoints/.test(await run("/checkpoints")));
ok("/hooks says none are registered", /no hooks registered/.test(await run("/hooks")));
ok("/webhooks says none arrived", /none received yet/.test(await run("/webhooks")));
ok("/memory reports the empty bank", /memory:/.test(await run("/memory")));
ok("/schedule reports no runs", /no scheduled runs/.test(await run("/schedule")));
ok("/rewind says there is nothing yet", /nothing to rewind to/.test(await run("/rewind")));
ok("/trace says there is no trace yet", /no trace yet/.test(await run("/trace")));
ok("/clear clears the conversation", /conversation cleared/.test(await run("/clear")));
ok("/security without args shows usage", /usage: \/security scan/.test(await run("/security")));
ok("/commit with nothing blocked says so", /nothing blocked/.test(await run("/commit")));
ok("/vault reports no vault in an empty home", /no obsidian vault configured/.test(await run("/vault")));
ok("/tabs lists the agents", /agents \(1\)/.test(await run("/tabs")));
ok("/new opens an agent", /new agent/.test(await run("/new scratch")));
ok("...and /tabs then shows two", /agents \(2\)/.test(await run("/tabs")));

console.log(fails ? `\n${fails} FAILED` : "\nall serve-parity checks passed");
await fs.rm(fake, { recursive: true, force: true }).catch(() => {});
process.exit(fails ? 1 : 0);

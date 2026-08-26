// Verify (computer-use MCP: the always-prompt guard + image results).
//
// The guard's whole point is the case the ordinary `mutating` flag does NOT
// cover. A merely-mutating tool is waved straight through in yolo mode, and a
// prior "always" approval waves it through in ask mode — so marking desktop
// control `mutating` would have let an irreversible click run unattended. This
// pins the property that matters: a computer-use tool prompts in EVERY mode, and
// no approval can pre-authorize it.
//
// Also covers the screenshot path: MCP image blocks used to flatten to the
// literal text "[image image/png]" with the bytes discarded, so a screenshot was
// invisible to the model.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const imp = (f) => import(pathToFileURL(path.resolve(here, f)).href);

const { gate } = await imp("../dist/permissions.js");
const { splitContent } = await imp("../dist/mcp/client.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

const CWD = process.cwd();
const ctx = (mode, approvals = []) => ({ mode, approvals: new Set(approvals), cwd: CWD });
const desktopTool = { name: "mcp__computer-use__screenshot", mutating: true, computerUse: true, source: "mcp" };
const ordinaryMcpTool = { name: "mcp__playwright__browser_navigate", mutating: true, source: "mcp" };
const readOnlyMcpTool = { name: "mcp__context7__get_docs", mutating: false, source: "mcp" };

// --- 1. the property `mutating` alone does not give you ----------------------
{
  for (const mode of ["ask", "yolo"]) {
    const d = gate(desktopTool, {}, ctx(mode));
    ok(`computer use PROMPTS in ${mode} mode`, d.kind === "prompt");
    ok(`...and is flagged dangerous in ${mode} mode`, d.kind === "prompt" && d.dangerous === true);
  }
  const d = gate(desktopTool, {}, ctx("plan"));
  ok("plan mode rejects it outright", d.kind === "reject");
}

// --- 2. no prior approval can pre-authorize a desktop action ----------------
{
  // Approve it once under every key the gate could plausibly use, then re-gate.
  const keys = ["mcp__computer-use__screenshot", "mcp__computer-use__screenshot:", "screenshot"];
  const d = gate(desktopTool, {}, ctx("ask", keys));
  ok('a prior "always" does NOT wave computer use through', d.kind === "prompt" && d.dangerous === true);
}

// --- 3. the contrast: ordinary MCP tools keep their old behaviour ------------
{
  ok("an ordinary mutating MCP tool still auto-approves in yolo", gate(ordinaryMcpTool, {}, ctx("yolo")).kind === "allow");
  ok("an ordinary mutating MCP tool still prompts in ask", gate(ordinaryMcpTool, {}, ctx("ask")).kind === "prompt");
  ok("...and not as dangerous", gate(ordinaryMcpTool, {}, ctx("ask")).dangerous === false);
  ok("a read-only MCP tool still runs free", gate(readOnlyMcpTool, {}, ctx("ask")).kind === "allow");
}

// --- 4. the prompt says WHY, so the approval is informed ---------------------
{
  const d = gate(desktopTool, {}, ctx("ask"));
  ok("the prompt names computer use as the reason", d.kind === "prompt" && /computer use/i.test(d.reason ?? ""));
  ok("...and says what it controls", d.kind === "prompt" && /mouse|keyboard|screen/i.test(d.reason ?? ""));
}

// --- 5. screenshots come back as images, not as a placeholder ---------------
{
  const png = "iVBORw0KGgoAAAANSUhEUg==";
  const r = splitContent([
    { type: "text", text: "captured the screen" },
    { type: "image", mimeType: "image/png", data: png },
  ]);
  ok("the image block yields an ImagePart", r.images.length === 1);
  ok("...carrying the real bytes, not a placeholder", r.images[0].data === png);
  ok("...with its mime type", r.images[0].mime === "image/png");
  ok("the text still comes through", /captured the screen/.test(r.text));
  ok("...and says the image was attached", /attached to the next message/.test(r.text));

  const two = splitContent([
    { type: "image", mimeType: "image/png", data: png },
    { type: "image", mimeType: "image/jpeg", data: png },
  ]);
  ok("several images all survive", two.images.length === 2);
  ok("...with distinct sources", two.images[0].source !== two.images[1].source);

  ok("a text-only result yields no images", splitContent([{ type: "text", text: "ok" }]).images.length === 0);
  ok("a malformed image block degrades to a placeholder", splitContent([{ type: "image", mimeType: "image/png" }]).images.length === 0);
  ok("non-array content is handled", splitContent(undefined).text === "" && splitContent(undefined).images.length === 0);
}

// --- 6. "never touch ~/.dom" is ENFORCED for computer use, not just advised ---
{
  // The built-in tools hard-reject ~/.dom. A computer-use server publishes its own
  // filesystem/script tools with their own argument shapes, so without an explicit
  // rule the same file would only prompt — one careless approval away from leaking
  // the API key. Both must reject outright.
  const home = String(process.env.USERPROFILE ?? process.env.HOME ?? "").split(String.fromCharCode(92)).join("/");
  const fsTool = { name: "mcp__computer-use__filesystem", mutating: true, computerUse: true, source: "mcp" };
  const script = { name: "mcp__computer-use__run_script", mutating: true, computerUse: true, source: "mcp" };

  ok("computer use is hard-BLOCKED from ~/.dom/.env (not merely prompted)",
    gate(fsTool, { mode: "read", path: home + "/.dom/.env" }, ctx("yolo")).kind === "reject");
  ok("...whatever the argument is named",
    gate(fsTool, { mode: "read", target: home + "/.dom/config.json" }, ctx("ask")).kind === "reject");
  ok("...and however deeply it is nested",
    gate(fsTool, { ops: [{ src: home + "/.dom/sessions/x.json" }] }, ctx("ask")).kind === "reject");
  ok("a script that reads ~/.dom is blocked too",
    gate(script, { script: "Get-Content ~/.dom/.env" }, ctx("ask")).kind === "reject");

  // The readable pockets stay reachable, and ordinary paths are unaffected.
  ok("the skills/ pocket is still reachable (prompting, not blocked)",
    gate(fsTool, { path: home + "/.dom/skills/x.md" }, ctx("ask")).kind === "prompt");
  ok("an ordinary desktop path still just prompts",
    gate(fsTool, { path: home + "/Desktop/notes.txt" }, ctx("ask")).kind === "prompt");
  // Scoped to computer use: an ordinary MCP tool keeps its old behaviour.
  ok("a non-computer-use MCP tool is unaffected by this rule",
    gate({ name: "mcp__playwright__browser_navigate", mutating: true, source: "mcp" }, { url: home + "/.dom/.env" }, ctx("yolo")).kind === "allow");
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);

// Verify (computer-use MCP: the prompt-until-authorized guard + image results).
//
// The guard's whole point is the case the ordinary `mutating` flag does NOT
// cover: a merely-mutating tool is waved through unseen, so marking desktop
// control `mutating` would have let an irreversible click run with the user
// never having said yes to desktop control at all. What this pins is that
// consent is REQUIRED and INFORMED — a computer-use tool prompts, flagged
// dangerous and naming what it controls, until the user explicitly authorizes
// it.
//
// It is deliberately silenceable after that. It used to be architecturally
// un-silenceable (dangerous calls skipped the approvals shortcut outright),
// which meant a voice session driving the desktop threw an Allow/Deny card for
// every individual mouse move — VOICE-UI-ISSUES.md #4. One "always" now covers
// the server, because one "click that for me" turn fires mouse_move, left_click,
// screenshot and type in sequence and answering four cards is not consent, it is
// attrition.
//
// The safety that actually matters is NOT what the user can approve away, and
// section 6 pins it: ~/.dom is a hard block and a write-scope violation is a
// hard reject, in every mode, approved or not.
//
// Also covers the screenshot path: MCP image blocks used to flatten to the
// literal text "[image image/png]" with the bytes discarded, so a screenshot was
// invisible to the model.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const imp = (f) => import(pathToFileURL(path.resolve(here, f)).href);

const { gate, approvalKey } = await imp("../dist/permissions.js");
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
  // Unauthorized, it prompts — and is flagged dangerous, so a headless run
  // refuses it rather than clicking unattended.
  const d = gate(desktopTool, {}, ctx("ask"));
  ok("computer use PROMPTS when nothing has authorized it", d.kind === "prompt");
  ok("...and is flagged dangerous", d.kind === "prompt" && d.dangerous === true);
  ok("...so a headless run refuses rather than allows", d.kind === "prompt" && d.nonInteractive !== "allow");
  ok("plan mode rejects it outright", gate(desktopTool, {}, ctx("plan")).kind === "reject");
}

// --- 2. an explicit authorization silences it; a stray one does not ---------
{
  const key = approvalKey(desktopTool, {});
  ok("the approval key is the SERVER, not the individual tool", key === "mcp-server:computer-use");

  // The point of keying on the server: approving once gets a whole "click that
  // for me" turn through, not just the one tool that happened to prompt.
  const click = { name: "mcp__computer-use__left_click", mutating: true, computerUse: true, source: "mcp" };
  const type = { name: "mcp__computer-use__type", mutating: true, computerUse: true, source: "mcp" };
  ok("one always covers the screenshot that asked for it", gate(desktopTool, {}, ctx("ask", [key])).kind === "allow");
  ok("...and the click that follows it", gate(click, {}, ctx("ask", [key])).kind === "allow");
  ok("...and the typing after that", gate(type, {}, ctx("ask", [key])).kind === "allow");
  ok("yolo mode covers it too", gate(desktopTool, {}, ctx("yolo")).kind === "allow");

  // But only a real authorization counts. An approval for a different server, or
  // one keyed the old per-tool way, must not leak desktop control.
  ok("an approval for a DIFFERENT server does not authorize this one",
    gate(desktopTool, {}, ctx("ask", ["mcp-server:playwright"])).kind === "prompt");
  ok("a stale per-tool key does not authorize it either",
    gate(desktopTool, {}, ctx("ask", ["mcp__computer-use__screenshot"])).kind === "prompt");
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

  // The line that makes the new "always" safe to offer at all: authorizing
  // desktop control authorizes CLICKING, never reaching past the gate. A user
  // who said "always" to the mouse has not said yes to the API key.
  const authorized = ctx("ask", [approvalKey(fsTool, {})]);
  ok('an "always" does NOT unlock ~/.dom for a computer-use tool',
    gate(fsTool, { path: home + "/.dom/.env" }, authorized).kind === "reject");
  ok("...nor does yolo", gate(script, { script: "type ~/.dom/config.json" }, ctx("yolo")).kind === "reject");
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);

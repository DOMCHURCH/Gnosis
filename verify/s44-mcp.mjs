// Verify (MCP wiring — hermetic): the default ~/.dom/mcp.json registry ships the
// three servers with the right transport + mutating flags, and dynamic MCP tools
// published into the tool registry are resolvable, advertised, and pass their raw
// JSON Schema through to the model verbatim. No servers are spawned here (that
// needs network + a browser — see the live check in the commit notes).
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { defaultMcpConfig, ensureMcpConfig, loadMcpConfig, mcpConfigPath } = await import("../dist/mcp/config.js");
const { setMcpToolDefs, resolveTool, allToolNames, toolDefinitions, TOOL_NAMES } = await import("../dist/tools/index.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- default registry --------------------------------------------------------
const def = defaultMcpConfig().mcpServers;
ok("default registry ships context7 + playwright + chrome-devtools", !!def.context7 && !!def.playwright && !!def["chrome-devtools"]);
ok("all three use stdio + npx", ["context7", "playwright", "chrome-devtools"].every((n) => def[n].command === "npx" && (def[n].transport ?? "stdio") === "stdio"));
ok("Playwright is gated as mutating; Context7 is read-only", def.playwright.mutating === true && def.context7.mutating === false);

// --- ensure/load ~/.dom/mcp.json --------------------------------------------
const created = await ensureMcpConfig();
ok("ensureMcpConfig writes ~/.dom/mcp.json on first run", created === true && (await fs.readFile(mcpConfigPath(), "utf8")).includes("playwright"));
ok("a second ensure does not overwrite", (await ensureMcpConfig()) === false);
const loaded = await loadMcpConfig();
ok("loadMcpConfig reads back the three servers", Object.keys(loaded.mcpServers).length === 3);

// --- dynamic tool registry ---------------------------------------------------
const jsonSchema = { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false };
setMcpToolDefs({
  "mcp__playwright__browser_navigate": {
    name: "mcp__playwright__browser_navigate",
    description: "[MCP · playwright] navigate",
    schema: z.any(),
    jsonSchema,
    mutating: true,
    source: "mcp",
    run: async () => ({ output: "navigated", isError: false }),
  },
});
ok("resolveTool finds a published MCP tool", !!resolveTool("mcp__playwright__browser_navigate"));
ok("resolveTool still finds built-ins", resolveTool("read")?.mutating === false);
ok("allToolNames merges built-ins + MCP tools", allToolNames().includes("read") && allToolNames().includes("mcp__playwright__browser_navigate"));

const defs = toolDefinitions(["read", "mcp__playwright__browser_navigate"]);
const mcpDef = defs.find((d) => d.function.name === "mcp__playwright__browser_navigate");
ok("the MCP tool is advertised to the model", !!mcpDef);
ok("its parameters are the server's JSON Schema, verbatim", JSON.stringify(mcpDef.function.parameters) === JSON.stringify(jsonSchema));
const readDef = defs.find((d) => d.function.name === "read");
ok("built-in params still derive from the zod schema", !!readDef && readDef.function.parameters?.type === "object");

setMcpToolDefs({}); // reset
ok("clearing MCP defs removes them but keeps built-ins", !resolveTool("mcp__playwright__browser_navigate") && allToolNames().length === TOOL_NAMES.length);

try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

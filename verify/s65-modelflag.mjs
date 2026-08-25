// Verify (/model flag parsing): the --save flag is found by scanning tokens, not
// by position, so it works before OR after the model id. Positional parsing was
// the bug — it recognised only a LEADING flag, so `/model <id> --save` folded
// "--save" into the model query and matched nothing.
import { parseModelCommand } from "../dist/models.js";
import { loadConfig, saveConfig, configIsBroken } from "../dist/config.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const ID = "deepseek/deepseek-v4-flash";

// --- the two orders must be identical ----------------------------------------
const before = parseModelCommand(`--save ${ID}`);
ok("--save before the id sets save", before.save === true);
ok("...and keeps the id clean", before.model === ID);

const after = parseModelCommand(`${ID} --save`);
ok("--save after the id sets save", after.save === true);
ok("...and keeps the id clean", after.model === ID);
ok("both orders parse identically", before.save === after.save && before.model === after.model);

// --- the short flag behaves the same -------------------------------------------
ok("-s before the id", parseModelCommand(`-s ${ID}`).save === true);
ok("-s after the id", parseModelCommand(`${ID} -s`).save === true);
ok("-s keeps the id clean", parseModelCommand(`${ID} -s`).model === ID);

// --- no flag --------------------------------------------------------------------
ok("a bare id does not save", parseModelCommand(ID).save === false);
ok("...and is returned as the model", parseModelCommand(ID).model === ID);

// --- flag alone means 'save whatever is current' --------------------------------
ok("--save alone sets save", parseModelCommand("--save").save === true);
ok("...with no model, so the caller saves the current one", parseModelCommand("--save").model === "");

// --- empty / whitespace opens the picker ----------------------------------------
ok("empty args save nothing", parseModelCommand("").save === false);
ok("...and name no model", parseModelCommand("").model === "");
ok("whitespace-only names no model", parseModelCommand("   ").model === "");
ok("undefined is tolerated", parseModelCommand(undefined).model === "");

// --- a multi-word search survives the filter ------------------------------------
ok("a two-word query is preserved", parseModelCommand("claude sonnet").model === "claude sonnet");
ok("...even with the flag mixed in", parseModelCommand("claude --save sonnet").model === "claude sonnet");
ok("...and the flag is still seen", parseModelCommand("claude --save sonnet").save === true);

// --- messy input ----------------------------------------------------------------
ok("extra whitespace collapses", parseModelCommand(`  --save   ${ID}  `).model === ID);
ok("a repeated flag is harmless", parseModelCommand(`--save ${ID} --save`).model === ID);
ok("...and still saves", parseModelCommand(`--save ${ID} --save`).save === true);

// The id contains a slash and a hyphen; neither may be mistaken for a flag.
ok("a hyphen inside the id is not a flag", parseModelCommand(ID).model === ID);
ok("an unrelated flag is not treated as --save", parseModelCommand(`${ID} --force`).save === false);

// --- a hand-edited config must still load ------------------------------------
// PowerShell Set-Content/Out-File and Notepad write a UTF-8 BOM. JSON.parse
// throws on it, and loadConfig swallowed the error and returned {} — so a saved
// model (and mode, and every other setting) was silently ignored, with nothing
// to show for it. That is the failure this file is really about.
{
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gnosis-cfg-"));
  const prevHome = process.env.USERPROFILE;
  const prevUnix = process.env.HOME;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  await fs.mkdir(path.join(home, ".dom"), { recursive: true });
  const cfg = path.join(home, ".dom", "config.json");

  const BOM = String.fromCharCode(0xfeff);
  await fs.writeFile(cfg, BOM + JSON.stringify({ model: "deepseek/deepseek-v4-flash", mode: "yolo" }, null, 4), "utf8");
  const loaded = await loadConfig();
  ok("a BOM-prefixed config still loads its model", loaded.model === "deepseek/deepseek-v4-flash");
  ok("...and its other settings", loaded.mode === "yolo");
  ok("...and is not reported as broken", (await configIsBroken()) === false);

  await saveConfig({ model: "anthropic/claude-haiku-4.5" });
  const after = await loadConfig();
  ok("saving a model preserves unrelated settings", after.mode === "yolo");
  ok("...and applies the new value", after.model === "anthropic/claude-haiku-4.5");
  ok("...and rewrites the file without a BOM", (await fs.readFile(cfg, "utf8")).charCodeAt(0) !== 0xfeff);

  await fs.writeFile(cfg, "{ this is not json", "utf8");
  ok("an unparseable config is reported as broken", (await configIsBroken()) === true);
  ok("...and still loads as empty rather than throwing", Object.keys(await loadConfig()).length === 0);
  await saveConfig({ model: "x/y" });
  ok("...and the original is kept beside it, not destroyed", await fs.readFile(cfg + ".bak", "utf8").then(() => true).catch(() => false));

  await fs.rm(cfg, { force: true });
  await fs.rm(cfg + ".bak", { force: true });
  ok("an absent config is not reported as broken", (await configIsBroken()) === false);

  if (prevHome === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevHome;
  if (prevUnix === undefined) delete process.env.HOME; else process.env.HOME = prevUnix;
  try { await fs.rm(home, { recursive: true, force: true }); } catch {}
}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

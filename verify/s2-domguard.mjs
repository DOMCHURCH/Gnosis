// Verify: (a) the ~/.dom hard block carves out cache/ and skills/ for bash the
// same way it already does for path tools — a bash command may read/write under
// ~/.dom/cache and ~/.dom/skills but stays blocked from config.json, .env, and
// sessions/; (b) the 413 limitPhrase never truncates a limit number mid-digit.
process.env.USERPROFILE = "C:/Users/Dominique/dom/verify/_fakehome";
process.env.HOME = process.env.USERPROFILE;

import { gate, domTarget } from "../dist/permissions.js";
import { TOOLS } from "../dist/tools/index.js";
import { limitPhrase } from "../dist/engine.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "✓" : "✗"} ${name}`); if (!cond) fails++; };

const bash = TOOLS.bash;
const read = TOOLS.read;
// The ~/.dom guard keys off the homedir + the command/path text, not cwd — pass a
// stable cwd for the resolved absolute path (matters only for relative paths).
const CWD = process.cwd();
const blockedByBash = (command) => domTarget(CWD, bash, { command }) !== null;

// --- bash carve-out: cache/ and skills/ are allowed pockets --------------------
ok("bash may read ~/.dom/cache", !blockedByBash("cat ~/.dom/cache/publicapis.json"));
ok("bash may write ~/.dom/cache", !blockedByBash("echo x > ~/.dom/cache/list.json"));
ok("bash may read ~/.dom/skills", !blockedByBash("cat ~/.dom/skills/public-apis/SKILL.md"));
ok("bash allows a deep cache path", !blockedByBash("grep foo ~/.dom/cache/apis/index.json"));

// --- bash carve-out: everything else under ~/.dom stays blocked ----------------
ok("bash blocked from config.json", blockedByBash("cat ~/.dom/config.json"));
ok("bash blocked from .env", blockedByBash("cat ~/.dom/.env"));
ok("bash blocked from sessions/", blockedByBash("ls ~/.dom/sessions"));
ok("bash blocked from the bare ~/.dom dir", blockedByBash("ls ~/.dom"));
ok("bash blocked from rm -rf ~/.dom", blockedByBash("rm -rf ~/.dom"));
ok("a mixed command touching .env too is blocked", blockedByBash("cat ~/.dom/cache/x && cat ~/.dom/.env"));
ok("a command naming no .dom path is unaffected", !blockedByBash("ls src"));

// --- the gate agrees: cache is allowed (in yolo), config.json is a hard reject --
ok("gate allows bash reading cache (yolo)", gate(bash, { command: "cat ~/.dom/cache/x" }, { mode: "yolo", approvals: new Set(), cwd: CWD }).kind === "allow");
{
  const d = gate(bash, { command: "cat ~/.dom/.env" }, { mode: "yolo", approvals: new Set(), cwd: CWD });
  ok("gate rejects bash reading .env (never a prompt)", d.kind === "reject" && /\.dom/.test(d.reason));
}

// --- path tools keep the same carve-out (read cache ok, config blocked) --------
ok("read may open ~/.dom/cache", domTarget(CWD, read, { path: "~/.dom/cache/x" }) === null);
ok("read blocked from ~/.dom/config.json", domTarget(CWD, read, { path: "~/.dom/config.json" }) !== null);

// --- 413 limit phrase keeps the FULL number even when it straddles the cut -----
{
  // Build a >160-char message where "8000" sits across index 160 of the phrase.
  const msg = "A".repeat(158) + "8000 tokens is the per-minute cap for this model.";
  const detail = JSON.stringify({ error: { message: msg, code: 413 } });
  const phrase = limitPhrase(detail);
  ok("limitPhrase keeps the full number (not '80')", phrase.includes("8000"));
  ok("limitPhrase did not dump the whole body", phrase.length < msg.length + 10);
}
ok("limitPhrase passes a short message through intact", limitPhrase(JSON.stringify({ error: { message: "TPM limit: 30000" } })) === "TPM limit: 30000");

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

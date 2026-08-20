// Verify (2.7 — command-hiding defense): normalizeCommand reveals tabs, invisible/
// bidi Unicode, and control chars as <U+XXXX>, flags them suspicious, and shows the
// full multi-line command; buildBashPreview displays the revealed command + a
// warning; the gate forces a prompt even in yolo when a command hides characters.
process.env.USERPROFILE = "C:/Users/Dominique/dom/verify/_fakehome-cmd";
process.env.HOME = process.env.USERPROFILE;

import { normalizeCommand, hasHiddenChars } from "../dist/cmdnorm.js";
import { gate, buildBashPreview } from "../dist/permissions.js";
import { TOOLS } from "../dist/tools/index.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };
const bash = TOOLS.bash;
const CWD = process.cwd();

// --- normalizeCommand --------------------------------------------------------
{
  const zwsp = "echo hi​rm -rf /tmp/x"; // zero-width space hiding a second command
  const n = normalizeCommand(zwsp);
  ok("invisible Unicode is revealed as <U+200B>", n.display.includes("<U+200B>") && !n.display.includes("​"));
  ok("...and flagged suspicious", n.suspicious && n.reasons.includes("invisible/bidi Unicode"));

  const bidi = "echo ‮gnp.elifeatski"; // RTL override
  ok("a bidi override is revealed + suspicious", normalizeCommand(bidi).display.includes("<U+202E>") && hasHiddenChars(bidi));

  const ctrl = "echo a rm"; // BEL
  ok("a control char is revealed as <U+0007> + suspicious", normalizeCommand(ctrl).display.includes("<U+0007>") && hasHiddenChars(ctrl));

  const tab = "echo\tsecret";
  ok("a tab is revealed and flagged", normalizeCommand(tab).display.includes("⇥") && hasHiddenChars(tab) && normalizeCommand(tab).reasons.includes("tab characters"));

  const multi = "cd repo\nrm -rf build";
  const nm = normalizeCommand(multi);
  ok("a multi-line command shows ALL lines (chaining not hidden)", nm.display.includes("cd repo") && nm.display.includes("rm -rf build"));
  ok("...noted but NOT forced-suspicious (it's visible)", nm.reasons.includes("multiple lines / chained commands") && !nm.suspicious);

  ok("a plain command is untouched and not suspicious", (() => { const p = normalizeCommand("npm run build"); return p.display === "npm run build" && !p.suspicious; })());
}

// --- buildBashPreview reveals + warns ---------------------------------------
{
  const prev = buildBashPreview(CWD, "echo hi​rm -rf /tmp/x");
  ok("the preview shows the revealed command", prev.command.includes("<U+200B>"));
  ok("the preview is marked dangerous with a hidden-characters warning", prev.dangerous === true && /hidden characters revealed/.test(prev.warning ?? ""));
}

// --- the gate forces a prompt even in yolo ----------------------------------
{
  const d = gate(bash, { command: "echo hi​rm -rf /tmp/x" }, { mode: "yolo", approvals: new Set(), cwd: CWD });
  ok("a hidden-character command PROMPTS even in yolo", d.kind === "prompt" && d.dangerous === true);
  const clean = gate(bash, { command: "echo hello" }, { mode: "yolo", approvals: new Set(), cwd: CWD });
  ok("a clean command still auto-approves in yolo", clean.kind === "allow");
}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

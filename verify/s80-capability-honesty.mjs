// Verify (capability honesty): the model is told, every turn, which approval
// regime it is actually in — and the computer-use section asserts the capability
// instead of letting the model deny access it holds.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { Engine } = await import("../dist/engine.js");
const { createSession } = await import("../dist/config.js");
const { buildSystemPrompt } = await import("../dist/system-prompt.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

const mk = (mode) => {
  const e = new Engine({ apiKey: "k", cwd: process.cwd(), systemPrompt: "BASE", models: [], session: createSession(process.cwd(), "m", mode), skills: [] });
  e.mode = mode;
  return e;
};

// --- the live approval regime reaches the model -------------------------------
const yolo = mk("yolo").currentSystemPrompt();
ok("yolo names itself", /APPROVAL MODE: yolo/.test(yolo));
ok("yolo says calls run immediately", /IMMEDIATELY/.test(yolo));
ok("yolo forbids promising an approval prompt", /will not/.test(yolo) && /not tell the user they will be asked/i.test(yolo));

const ask = mk("ask").currentSystemPrompt();
ok("ask names itself", /APPROVAL MODE: ask/.test(ask));
ok("ask does NOT claim calls run unprompted", !/run IMMEDIATELY/.test(ask));

const edits = mk("ask");
edits.autoApproveEdits = true;
ok("auto-approved edits are stated, not hidden", /edits auto-approved/.test(edits.currentSystemPrompt()));

const plan = mk("plan").currentSystemPrompt();
ok("plan states it is read-only", /APPROVAL MODE: plan/.test(plan) && /read-only/.test(plan));

// The notice must track a runtime switch — it is rebuilt per turn, not baked in.
const flip = mk("ask");
ok("before the switch it reads as ask", /APPROVAL MODE: ask/.test(flip.currentSystemPrompt()));
flip.setMode("yolo");
ok("after shift+tab it reads as yolo", /APPROVAL MODE: yolo/.test(flip.currentSystemPrompt()));
ok("...and the stale ask line is gone", !/APPROVAL MODE: ask/.test(flip.currentSystemPrompt()));

// --- computer use asserts the capability --------------------------------------
const sys = await buildSystemPrompt(process.cwd(), [], 0);
ok("computer use is still documented", /COMPUTER USE/.test(sys));
ok("a listed desktop tool means the capability is held", /YOU HAVE THAT CAPABILITY/.test(sys));
ok("denying computer access is forbidden", /Never tell the user you have no access to their computer/.test(sys));
ok("promising a per-action confirmation is forbidden", /Never state or imply that the user will get a confirmation prompt/.test(sys));
ok("the announcement is named as the real safeguard", /only warning the user is guaranteed to get/.test(sys));
ok("sensitive windows are still off limits", /~\/\.ssh/.test(sys) && /password manager/.test(sys));
ok("capability claims must come from the tool list", /STATING YOUR OWN CAPABILITIES/.test(sys) && /If a tool\s+is listed, you have it/.test(sys.replace(/\n/g, "\n")));

try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

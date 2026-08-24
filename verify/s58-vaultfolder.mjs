// Verify (Obsidian folder routing): saveVaultNote writes into a subfolder (creating
// it on demand), guards against traversal, and still writes to the root when no
// folder is given — so auto-save can route to Code/ · Research/ · Decisions/.
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake; process.env.HOME = fake;
await fs.mkdir(path.join(fake, ".dom"), { recursive: true });
const vault = await fs.mkdtemp(path.join(os.tmpdir(), "dom-vault-"));
await fs.writeFile(path.join(fake, ".dom", "config.json"), JSON.stringify({ obsidianVault: vault }));

const { saveVaultNote } = await import("../dist/vault.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

try {
  // Code/ — folder created on demand.
  const r1 = await saveVaultNote("fetch-api-2026-08-24", ["auto-saved"], "const x = 1;", "Code");
  ok("saves into Code/ and returns the subfolder path", r1.ok && r1.path === "Code/fetch-api-2026-08-24.md");
  ok("the Code/ folder was created", existsSync(path.join(vault, "Code")));
  ok("the note exists on disk under Code/", existsSync(path.join(vault, "Code", "fetch-api-2026-08-24.md")));

  // Research/ and Decisions/
  const r2 = await saveVaultNote("why-postgres", [], "long explanation", "Research");
  ok("saves into Research/", r2.ok && r2.path === "Research/why-postgres.md");
  const r3 = await saveVaultNote("use-a-queue", [], "decision text", "Decisions");
  ok("saves into Decisions/", r3.ok && r3.path === "Decisions/use-a-queue.md");

  // No folder → root (unchanged behavior).
  const r4 = await saveVaultNote("scratch", [], "note", undefined);
  ok("no folder → saved at the vault root", r4.ok && r4.path === "scratch.md" && existsSync(path.join(vault, "scratch.md")));

  // Traversal is neutralized (kept inside the vault).
  const r5 = await saveVaultNote("evil", [], "x", "../../etc");
  ok("a traversal folder is sanitized, staying inside the vault", r5.ok && !r5.path.includes("..") && existsSync(path.join(vault, r5.path)));

  // Doesn't clobber — a second save with the same name+folder gets a suffix.
  const r6 = await saveVaultNote("fetch-api-2026-08-24", [], "v2", "Code");
  ok("a duplicate name in the same folder is suffixed", r6.ok && r6.path === "Code/fetch-api-2026-08-24 2.md");
} catch (e) {
  ok(`vault-folder completed (${e.message})`, false);
}

try { await fs.rm(fake, { recursive: true, force: true }); await fs.rm(vault, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

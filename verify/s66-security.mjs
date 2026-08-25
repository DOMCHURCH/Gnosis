// Verify (secret scanning): the detectors fire on real key shapes, the write is
// never dropped, exemptions work, and — the rule that matters most — a detected
// secret is never echoed back to the model.
import { scanText, scanFile, redact, isExempt, loadSecurityIgnore, warningLine, toolNote, SECURITY_IGNORE_FILE } from "../dist/security.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

// The exact fixture from the spec.
const FAKE = "sk-test1234567890123456789012";

// --- detection ------------------------------------------------------------------
const hit = scanText(`const key = "${FAKE}";`);
ok("an OpenAI-shaped key is detected", hit.length === 1);
ok("...named", /OpenAI/.test(hit[0].kind));
ok("...with the right line number", hit[0].line === 1);

ok("line numbers are 1-based and correct", scanText(`a\nb\nconst k = "${FAKE}"`)[0].line === 3);
ok("an AWS access key id is detected", scanText("AKIAIOSFODNN7EXAMPLE").length === 1);
ok("an npm token is detected", scanText(`npm_${"a".repeat(36)}`).length === 1);
ok("a GitHub PAT is detected", scanText(`ghp_${"b".repeat(36)}`).length === 1);
// Overlapping rules must not report one secret twice.
ok("...exactly once, not once per matching rule", scanText(`gho_${"c".repeat(36)}`).length === 1);
ok("a private key block is detected", scanText("-----BEGIN RSA PRIVATE KEY-----").length === 1);
ok("a bare private key block is detected", scanText("-----BEGIN PRIVATE KEY-----").length === 1);
ok("a hardcoded password is detected", scanText(`password = "hunter2000"`).length === 1);
ok("a Stripe secret key is detected", scanText("sk_live_abcdefghij0123456789").length === 1);

// --- the false positives that would make people ignore it -----------------------
ok("clean code is clean", scanText("const x = 1;\nexport default x;").length === 0);
ok("an env var reference is not a secret", scanText('const key = process.env.OPENAI_API_KEY;').length === 0);
ok("a password read from env is not hardcoded", scanText('password = os.getenv("PW")').length === 0);
ok("an empty password default is not flagged", scanText('password = ""').length === 0);
ok("a short value is not a password", scanText('password = "abc"').length === 0);
ok("prose mentioning sk- is not a key", scanText("keys look like sk-... in the docs").length === 0);
// Minified bundles are where entropy scanners go to die.
ok("a very long (minified) line is skipped", scanText("x".repeat(2500) + FAKE).length === 0);

// --- one finding per kind per line ----------------------------------------------
ok("a key repeated on one line is one finding", scanText(`"${FAKE}" and "${FAKE}"`).length === 1);
ok("the same key on two lines is two findings", scanText(`"${FAKE}"\n"${FAKE}"`).length === 2);

// --- redaction: the secret must never travel ------------------------------------
ok("redact keeps only a short head", redact(FAKE).startsWith("sk-t"));
ok("...and does not contain the secret", !redact(FAKE).includes(FAKE));
ok("...and is not reversible to the original length", redact(FAKE) !== FAKE);
const note = toolNote(scanText(`const key = "${FAKE}";`));
ok("the note sent to the MODEL never contains the secret", !note.includes(FAKE));
ok("...but does say where it is", /line 1/.test(note));
ok("...and how to exempt a fixture", note.includes(SECURITY_IGNORE_FILE));
ok("...and mentions the override", /--force/.test(note));
const warn = warningLine("a.ts", scanText(`const key = "${FAKE}";`));
ok("the warning line never contains the secret", !warn.includes(FAKE));
ok("...and reads as specified", /security: possible .* on line 1 .* auto-commit blocked/.test(warn));

// --- exemptions -----------------------------------------------------------------
ok("an exact path is exempt", isExempt("test/fixtures/keys.ts", ["test/fixtures/keys.ts"]));
ok("a directory exempts everything under it", isExempt("test/fixtures/keys.ts", ["test/fixtures"]));
ok("a glob exempts a pattern", isExempt("test/a.fixture.ts", ["test/*.fixture.ts"]));
ok("a double-star crosses directories", isExempt("a/b/c/keys.ts", ["**/keys.ts"]));
ok("an unrelated path is not exempt", !isExempt("src/app.ts", ["test/fixtures"]));
ok("a sibling sharing a prefix is not exempt", !isExempt("test/fixtures-real/k.ts", ["test/fixtures"]));
ok("no patterns exempts nothing", !isExempt("a.ts", []));

// --- on disk ---------------------------------------------------------------------
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gnosis-sec-"));
  const bad = path.join(root, "leak.ts");
  await fs.writeFile(bad, `const key = "${FAKE}";\n`, "utf8");
  const r1 = await scanFile(bad, root);
  ok("a file on disk is scanned", r1.findings.length === 1 && r1.exempt === false);

  await fs.writeFile(path.join(root, SECURITY_IGNORE_FILE), "# fixtures\nleak.ts\n", "utf8");
  const r2 = await scanFile(bad, root);
  ok("...and the exemption file silences it", r2.findings.length === 0 && r2.exempt === true);
  ok("comments and blanks are ignored in the exemption file", (await loadSecurityIgnore(root)).length === 1);

  const missing = await scanFile(path.join(root, "nope.ts"), root);
  ok("a missing file scans clean rather than throwing", missing.findings.length === 0);

  // The write must survive regardless — the scanner never deletes anything.
  ok("the scanned file is still on disk, untouched", (await fs.readFile(bad, "utf8")).includes(FAKE));
  try { await fs.rm(root, { recursive: true, force: true }); } catch {}
}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

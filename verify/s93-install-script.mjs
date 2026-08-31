// Verify (scripts/install.ps1): the one-command install stays runnable.
//
// This script is fetched over the network and executed by strangers on machines
// nobody here can see, which makes two ordinary mistakes unusually expensive.
//
// 1. NON-ASCII. Windows PowerShell 5.1 reads a .ps1 as ANSI unless it carries a
//    UTF-8 BOM — and a BOM does not survive `irm | iex` at all, since the content
//    arrives already decoded. A single em dash in a COMMENT was enough to mangle
//    the string on the next line and produce a wall of parse errors pointing at
//    the wrong places. Caught exactly that way while testing this.
// 2. A COMMAND THAT DOES NOT PARSE. There is no staging here: the first person to
//    run the published one-liner is the test. So parse it properly, with
//    PowerShell's own parser, not a regex.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "scripts", "install.ps1");

let fails = 0;
const ok = (n, c, extra = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${extra ? ` — ${extra}` : ""}`); if (!c) fails++; };

const buf = readFileSync(file);
const src = buf.toString("utf8");

// --- 1. every byte is 7-bit -------------------------------------------------
{
  const bad = [];
  for (let i = 0; i < buf.length && bad.length < 5; i++) if (buf[i] > 127) bad.push(i);
  ok("the script is pure ASCII", bad.length === 0,
    bad.length ? `first non-ASCII byte at offset ${bad[0]}` : `${buf.length} bytes`);
  // A BOM is worse than useless here: it does not reach `iex`, and locally it
  // masks the very problem the rule above exists to prevent.
  ok("...with no BOM", !(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf));
}

// --- 2. it parses, as a string, the way iex will see it ---------------------
if (process.platform !== "win32") {
  console.log("SKIP not Windows — PowerShell parse check not run");
} else {
  // ParseInput on the file CONTENTS, which is what `irm | iex` evaluates —
  // parsing the path instead would test a different thing.
  const ps = `
$src = [IO.File]::ReadAllText(${JSON.stringify(file)})
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$null, [ref]$errors)
if ($errors.Count) { $errors | ForEach-Object { Write-Output ("ERR " + $_.Message) } } else { Write-Output "CLEAN" }
$sb = [scriptblock]::Create($src)
Write-Output ("PARAMS " + (($sb.Ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath }) -join ','))
`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8", timeout: 60000, windowsHide: true,
  });
  const out = String(r.stdout ?? "");
  ok("it parses as a piped string (the irm | iex form)", /CLEAN/.test(out),
    /ERR/.test(out) ? out.split(/\r?\n/).filter((l) => l.startsWith("ERR")).slice(0, 2).join(" | ") : "");
  // The documented advanced form passes these; a rename silently breaks the
  // README's examples.
  const params = /PARAMS (.*)/.exec(out)?.[1] ?? "";
  for (const p of ["DownloadOnly", "OutDir", "Cli"]) {
    ok(`-${p} is still a parameter`, params.split(",").includes(p));
  }
}

// --- 3. it does what it claims ----------------------------------------------
{
  // Resolved at runtime, not hard-coded: a pinned version goes stale the next
  // time a release ships, and a stale installer link is how people end up
  // reporting bugs that were fixed months ago.
  ok("the release is resolved from the API, not hard-coded",
    /releases\/latest/.test(src) && !/releases\/download\/v\d/.test(src));
  ok("...and the asset is matched by pattern", /Gnosis-Setup-\*\.exe/.test(src));
  // A truncated download that "succeeded" fails much later as a corrupt
  // installer, naming the wrong culprit.
  ok("the download size is verified", /\$actual -ne \$asset\.size/.test(src));
  ok("...and a partial file is deleted rather than left to be run", /Remove-Item \$dest/.test(src));
  // TLS 1.2 is not optional on 5.1: GitHub refuses the default on some machines.
  ok("TLS 1.2 is forced for 5.1", /SecurityProtocolType\]::Tls12/.test(src));

  // It must never install a system runtime on someone's machine unasked. It may
  // only NAME them. `npm install -g` is allowed solely under the -Cli switch,
  // which is an explicit request.
  ok("it does not silently install Node", !/winget install.*NodeJS|choco install.*nodejs/i.test(src));
  ok("it does not silently install Python", !/winget install.*Python|choco install.*python/i.test(src));
  ok("...but it does say where to get them",
    /nodejs\.org/.test(src) && /python\.org/.test(src));
  ok("the required key is named", /openrouter\.ai\/keys/.test(src));
}

// --- 4. the README command matches the file that exists ---------------------
{
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  const m = /irm (https:\/\/raw\.githubusercontent\.com\/\S+install\.ps1)/.exec(readme);
  ok("the README publishes the one-liner", !!m);
  if (m) {
    // The path in the URL has to be the path in the repo, or the published
    // command 404s for everyone while working perfectly here.
    ok("...pointing at scripts/install.ps1", /\/scripts\/install\.ps1$/.test(m[1]));
    ok("...from this repo", /DOMCHURCH\/Gnosis/.test(m[1]));
  }
  // `iex` cannot forward parameters, so the README must not pretend otherwise.
  ok("the README does not pipe options into iex", !/\|\s*iex\s+-\w/.test(readme));
}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

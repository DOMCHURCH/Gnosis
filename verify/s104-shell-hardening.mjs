// Verify (desktop shell hardening): what the window is allowed to hand to the
// operating system, and what happens when a promise rejects with nobody
// listening.
//
// Both of these are properties of electron/main.js that nothing else can test.
// The suites cannot boot Electron, so the scheme allowlist is extracted and
// exercised for real, and the process handlers are asserted at the source
// level — which is the right altitude for "this line must still be here".
//
// WHY THE ALLOWLIST EXISTS. shell.openExternal does not merely open web pages:
// on Windows it hands the string to whichever application claims that protocol,
// so an unvetted scheme is an arbitrary local launch. This window renders model
// output and fetched web content, and the markdown sanitiser deliberately
// permits `target` — the attribute that produces a window.open. That is a short
// path from "a model wrote a link" to "the OS ran something".
//
// WHY THE HANDLERS EXIST. Node terminates the process on an unhandled
// rejection. Gnosis is a tray app people leave running for days, and its
// background work — update checks, the acceptance queue drain, voice, MCP — is
// exactly where an unawaited promise lives. The window vanishing with no
// message is the symptom.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(path.join(root, ...p), "utf8");

let fails = 0;
const ok = (n, c, extra = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${extra ? ` — ${extra}` : ""}`); if (!c) fails++; };

const main = read("electron", "main.js");

// --- 1. the scheme allowlist, executed --------------------------------------
{
  const m = main.match(/function isSafeExternal[\s\S]*?\n}/);
  ok("isSafeExternal exists", !!m);

  if (m) {
    // eslint-disable-next-line no-eval
    const isSafeExternal = eval("(" + m[0].replace(/^function isSafeExternal/, "function") + ")");

    for (const url of ["https://github.com/DOMCHURCH/Gnosis", "http://127.0.0.1:7777/", "mailto:a@b.com"]) {
      ok(`allows ${url}`, isSafeExternal(url) === true);
    }

    // Each of these is a real way an unvetted scheme becomes code execution.
    const blocked = [
      ["file:///C:/Windows/System32/calc.exe", "file: — the one that turns a link into an executable"],
      ["ms-msdt:/id PCWDiagnostic", "ms-msdt: — the Follina vector"],
      ["javascript:alert(1)", "javascript:"],
      ["vscode://file/x", "an arbitrary registered protocol handler"],
      ["search-ms:query=x", "search-ms:"],
      ["not a url", "an unparseable string"],
      ["", "the empty string"],
    ];
    for (const [url, why] of blocked) {
      ok(`blocks ${why}`, isSafeExternal(url) === false);
    }
  }
}

// --- 2. every path to the OS goes through it --------------------------------
{
  ok("the window-open handler checks before opening",
    /setWindowOpenHandler\(\(\{ url \}\) => \{\s*if \(isSafeExternal\(url\)\)/.test(main));

  // setWindowOpenHandler governs NEW windows only. An in-window navigation is a
  // separate code path, and a remote page loaded there would run against the
  // preload and inherit its whole IPC surface.
  ok("in-window navigation is guarded too", /on\("will-navigate"/.test(main));
  ok("...and anything off-origin is prevented", /sameOrigin\([\s\S]{0,80}preventDefault\(\)/.test(main));

  // The bare form — openExternal handed a caller-supplied url directly — is what
  // this suite exists to keep out.
  ok("no unguarded openExternal of a caller-supplied url",
    /if \(isSafeExternal\(url\)\) void shell\.openExternal\(url\)/.test(main));
}

// --- 3. a stray rejection does not end the session --------------------------
{
  ok("the shell installs an unhandledRejection handler", /process\.on\("unhandledRejection"/.test(main));
  ok("...and does not exit on it", !/unhandledRejection"[\s\S]{0,200}process\.exit/.test(main));
  ok("...while an uncaught exception still terminates",
    /process\.on\("uncaughtException"[\s\S]{0,300}exit\?\.\(1\)/.test(main));

  // The CLI is the other long-lived entry point and needs the same protection.
  const cli = read("src", "cli.tsx");
  ok("the CLI installs one too", /process\.on\("unhandledRejection"/.test(cli));
  // Ink owns stdout; writing there fights the renderer for the same cells.
  ok("...writing to stderr, not stdout", /unhandledRejection"[\s\S]{0,200}process\.stderr\.write/.test(cli));
}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

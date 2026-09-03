// Verify (gnosis:// deep link parsing): parseDeepLink is pure logic that
// doesn't need Electron itself (only registerDeepLinks does) — extracted and
// evaluated at the source level, same technique as s104-shell-hardening,
// because the suites cannot boot Electron.
//
// WHY THIS MATTERS: a gnosis:// link is trivially attacker-triggerable (any
// webpage or email link — no confirmation beyond the OS's own protocol-launch
// prompt), so gnosis://file/<path> must reject a UNC-shaped path (Explorer
// opening one is a well-known way to leak the machine's NTLM hash) and `..`
// traversal at the source, regardless of what the current renderer does with
// the parsed path.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(path.join(root, "electron", "deeplinks.js"), "utf8");

let fails = 0;
const ok = (n, c, extra = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${extra ? ` — ${extra}` : ""}`); if (!c) fails++; };

const schemeSrc = src.match(/const SCHEME = "[^"]+";/);
const safeFilePathSrc = src.match(/function safeFilePath[\s\S]*?\n}/);
const parseDeepLinkSrc = src.match(/export function parseDeepLink[\s\S]*?\n}\n/);
ok("SCHEME constant exists", !!schemeSrc);
ok("safeFilePath exists", !!safeFilePathSrc);
ok("parseDeepLink exists", !!parseDeepLinkSrc);

if (schemeSrc && safeFilePathSrc && parseDeepLinkSrc) {
  // Combined into ONE eval so parseDeepLink's closure actually captures SCHEME
  // and safeFilePath — strict-mode eval (all ESM code is strict) gives each
  // separate eval() call its own scope, so declarations from one eval never
  // leak into another; only variables in the SAME eval string are visible to
  // each other, via ordinary closure once this IIFE returns.
  // eslint-disable-next-line no-eval
  const { parseDeepLink, safeFilePath } = eval(
    "(function() {\n" +
      schemeSrc[0] + "\n" +
      safeFilePathSrc[0] + "\n" +
      parseDeepLinkSrc[0].replace(/^export function parseDeepLink/, "function parseDeepLink") + "\n" +
      "return { parseDeepLink, safeFilePath };\n" +
      "})()",
  );

  ok("session: a name opens/creates that session", JSON.stringify(parseDeepLink("gnosis://session/my-project")) === JSON.stringify({ action: "session", name: "my-project" }));
  ok("session: no name is ambiguous, refused", parseDeepLink("gnosis://session/") === null);
  ok("serve: no path needed", JSON.stringify(parseDeepLink("gnosis://serve")) === JSON.stringify({ action: "serve" }));
  ok("not our scheme: refused", parseDeepLink("https://evil.example.com/gnosis://file/x") === null);
  ok("unparseable: refused, not thrown", parseDeepLink("not a url") === null);
  ok("non-string: refused, not thrown", parseDeepLink(null) === null && parseDeepLink(undefined) === null && parseDeepLink(42) === null);

  ok("file: an ordinary relative path is allowed", JSON.stringify(parseDeepLink("gnosis://file/src/engine.ts")) === JSON.stringify({ action: "file", path: "src/engine.ts" }));
  ok("file: no path is refused", parseDeepLink("gnosis://file/") === null);
  ok("file: a UNC path is refused (NTLM-leak vector via Explorer)", parseDeepLink(`gnosis://file/${encodeURIComponent("\\\\attacker\\share\\x")}`) === null);
  ok("file: a leading // is refused too", parseDeepLink("gnosis://file/" + encodeURIComponent("//attacker/share/x")) === null);
  ok("file: .. traversal is refused", parseDeepLink("gnosis://file/" + encodeURIComponent("../../Windows/System32/cmd.exe")) === null);
  ok("file: traversal mixed into a longer path is still caught", parseDeepLink("gnosis://file/" + encodeURIComponent("a/b/../../../etc/passwd")) === null);
  ok("file: an implausibly long path is refused", parseDeepLink("gnosis://file/" + encodeURIComponent("x".repeat(5000))) === null);

  ok("safeFilePath: empty is refused", safeFilePath("") === null);
  ok("safeFilePath: a normal name passes through unchanged", safeFilePath("notes/todo.md") === "notes/todo.md");
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);

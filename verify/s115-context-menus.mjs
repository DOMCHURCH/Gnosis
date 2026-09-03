// Verify (file-browser context menu path containment): absolute() is pure
// path logic that doesn't need Electron itself — extracted and evaluated at
// the source level, same technique as s104-shell-hardening / s114-deeplinks,
// because the suites cannot boot Electron.
//
// WHY THIS MATTERS: "Reveal in Explorer" / "Copy path" resolve a file-browser
// path (relative to the session root) against the OS. Explorer opening a UNC
// path (\\host\share\...) makes an outbound SMB connection to whatever host
// is named — a well-known way to leak the machine's NTLM hash — and this
// renderer is served over HTTP to LAN browsers (see shell-preload.cjs), not
// only driven by the local user's own clicks.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(path.join(root, "electron", "context-menus.js"), "utf8");

let fails = 0;
const ok = (n, c, extra = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${extra ? ` — ${extra}` : ""}`); if (!c) fails++; };

const m = src.match(/function absolute\(root, p\) \{[\s\S]*?\n\}/);
ok("absolute() exists", !!m);

if (m) {
  // `path` (imported above) is visible here via the normal lexical scope
  // chain — strict-mode eval only isolates NEW declarations made inside it,
  // not reads of the surrounding scope.
  // eslint-disable-next-line no-eval
  const absolute = eval(
    "(function() {\n" +
      m[0] + "\n" +
      "return absolute;\n" +
      "})()",
  );
  const ROOT = "C:\\Users\\Dominique\\Gnosis\\workspace";

  ok("an ordinary relative path resolves inside root", absolute(ROOT, "notes\\todo.md") === path.join(ROOT, "notes", "todo.md"));
  ok("no path at all falls back to root itself", absolute(ROOT, "") === path.resolve(ROOT));
  ok("an absolute path INSIDE root is allowed", absolute(ROOT, path.join(ROOT, "sub", "x.txt")) === path.resolve(path.join(ROOT, "sub", "x.txt")));

  ok("a UNC path is refused, not resolved", absolute(ROOT, "\\\\attacker\\share\\x") === null);
  ok("a leading // is refused too", absolute(ROOT, "//attacker/share/x") === null);
  ok("plain .. traversal out of root is refused", absolute(ROOT, "..\\..\\Windows\\System32\\cmd.exe") === null);
  ok("traversal mixed into a longer relative path is still caught", absolute(ROOT, "sub\\..\\..\\..\\escape.txt") === null);
  ok("an absolute path on a DIFFERENT drive is refused", absolute(ROOT, "D:\\other\\drive") === null);
  ok("an absolute path elsewhere on the SAME drive, outside root, is refused", absolute(ROOT, "C:\\Windows\\System32") === null);
  ok("no root configured at all refuses rather than guessing", absolute(null, "x.txt") === null);
  ok("no root and no path returns null, not a fabricated path", absolute(null, "") === null);
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);

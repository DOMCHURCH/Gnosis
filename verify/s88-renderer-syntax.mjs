// Verify (desktop app): the shell's renderer scripts actually parse.
//
// This exists because of a single missing backslash. voice-engine.html carried
//     String(file).replace(/\/g, "/")
// where it meant `/\\/g` — which makes an unterminated regex literal, which makes
// the WHOLE inline <script> fail to parse, which means getUserMedia is never
// called and no handler is ever registered.
//
// Nothing reported it. The window is hidden, so there is no visible error; the
// main process only ever sees the ABSENCE of messages, and absence is exactly
// what "voice is off" looks like. The panel showed microphone disconnected,
// frames 0, level 0.000 and detector not running — four symptoms, one cause, and
// no line anywhere saying "this file did not parse".
//
// A hidden renderer cannot report its own syntax errors, so the check has to
// happen out here.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "electron");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

/** Every inline <script> body in an HTML file. */
function inlineScripts(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

const htmlFiles = readdirSync(dir).filter((f) => f.endsWith(".html"));
ok("there are renderer pages to check", htmlFiles.length > 0);

for (const f of htmlFiles) {
  const html = readFileSync(path.join(dir, f), "utf8");
  const scripts = inlineScripts(html);
  scripts.forEach((src, i) => {
    let error = null;
    try {
      // Compile only — never run. These scripts reach for window/document and a
      // preload bridge that does not exist out here; parsing is the whole point.
      new vm.Script(src, { filename: `${f}#${i}` });
    } catch (e) {
      error = e.message;
    }
    ok(`${f} script ${i + 1}/${scripts.length} parses`, !error);
    if (error) console.log(`     ${error}`);
  });
}

// The preloads are CommonJS and are the bridge every one of those scripts calls
// through — a syntax error here takes the page down just as completely.
for (const f of readdirSync(dir).filter((x) => x.endsWith(".cjs"))) {
  let error = null;
  try {
    new vm.Script(readFileSync(path.join(dir, f), "utf8"), { filename: f });
  } catch (e) {
    error = e.message;
  }
  ok(`${f} parses`, !error);
  if (error) console.log(`     ${error}`);
}

// The specific shape that caused it: a regex meant to match a literal backslash,
// written with one instead of two. Cheap to check, and it is the exact edit a
// shell heredoc silently makes.
const engine = readFileSync(path.join(dir, "voice-engine.html"), "utf8");
ok("the WAV path fix escapes its backslash", /replace\(\/\\\\\/g/.test(engine));

console.log(fails ? `\n${fails} FAILED` : "\nall renderer scripts parse");
process.exit(fails ? 1 : 0);

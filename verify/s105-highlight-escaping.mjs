// Verify (highlight helper): the one copy, and the escaping it guarantees.
//
// Every hl() result is injected with dangerouslySetInnerHTML, so escaping here
// is not cosmetic — it is the only thing between a file's contents and the DOM.
//
// This existed three times, with the same body and three DIFFERENT failure
// behaviours: DiffView and StreamDiff escaped the text, FileOutput returned "".
// That last one meant a highlighter which threw silently emptied the pane, and
// the user saw a file they had just opened as blank with nothing to explain it.
// Three copies is a smell; three copies that DISAGREE about failure is a bug
// living in exactly one of them.
//
// Source-level assertions, because the property is "there is one copy and every
// caller uses it" — which no runtime test can observe.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(path.join(root, ...p), "utf8");

let fails = 0;
const ok = (n, c, extra = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${extra ? ` — ${extra}` : ""}`); if (!c) fails++; };

// --- 1. exactly one definition ----------------------------------------------
{
  const dir = path.join(root, "web", "src");
  const files = readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f));
  const defs = files.filter((f) => /^\s*(export )?function hl\(/m.test(readFileSync(path.join(dir, f), "utf8")));
  ok("hl() is defined exactly once", defs.length === 1, defs.join(", ") || "none");
  ok("...in the shared module", defs[0] === "highlight.ts", defs[0]);

  const esc = files.filter((f) => /^\s*(export )?function escapeHtml\(/m.test(readFileSync(path.join(dir, f), "utf8")));
  ok("escapeHtml is defined exactly once", esc.length === 1, esc.join(", ") || "none");
}

// --- 2. every consumer imports it -------------------------------------------
{
  for (const f of ["DiffView.tsx", "FileOutput.tsx", "StreamDiff.tsx"]) {
    const s = read("web", "src", f);
    ok(`${f} imports the shared hl`, /import \{[^}]*\bhl\b[^}]*\} from "\.\/highlight"/.test(s));
    // A local hljs import here would be the first step back to a fourth copy.
    ok(`...and no longer imports hljs directly`, !/import hljs from/.test(s));
  }
}

// --- 3. the fallback shows the file, escaped --------------------------------
{
  const s = read("web", "src", "highlight.ts");
  ok("the catch escapes rather than returning nothing", /catch \{\s*return escapeHtml\(text\);/.test(s));
  // The regression that motivated this: an empty string in the failure path.
  ok("...and never returns the empty string on failure", !/catch \{\s*return "";/.test(s));

  ok("escapeHtml handles &", /replace\(\/&\/g, "&amp;"\)/.test(s));
  ok("...and <", /replace\(\/<\/g, "&lt;"\)/.test(s));
  ok("...and >", /replace\(\/>\/g, "&gt;"\)/.test(s));
  // & must be replaced FIRST, or the &s introduced by the later replacements
  // get double-escaped into &amp;lt;.
  ok("...replacing & before < and >", s.indexOf('"&amp;"') < s.indexOf('"&lt;"'));
}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

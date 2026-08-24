// Verify (Obsidian intent filtering): responses route to Code/ · Research/ ·
// Decisions/ by intent; short answers and thinly-prompted turns never save.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { classifyNote, noteSlug } = await import(pathToFileURL(path.resolve(here, "../web/src/notesort.js")).href);

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const USER = "please write a function that fetches the api and parses the json for me";      // 13 words
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

// Code response → Code/
ok("a code response routes to Code/", (() => {
  const v = classifyNote({ text: "Here is the function:\nconst x = 1;", hasCode: true, userMessage: USER });
  return v.save && v.folder === "Code";
})());

// Long explanation (no code, >300 words) → Research/
ok("a long explanation routes to Research/", (() => {
  const v = classifyNote({ text: words(320), hasCode: false, userMessage: USER });
  return v.save && v.folder === "Research";
})());

// Decision language → Decisions/
ok("a decision/plan routes to Decisions/", (() => {
  const v = classifyNote({ text: "We should take this approach because it avoids the tradeoff of blocking the event loop; " + words(40), hasCode: false, userMessage: USER });
  return v.save && v.folder === "Decisions";
})());

// Short answer → never
ok("a short reply is never saved", classifyNote({ text: "Yes, that works.", hasCode: false, userMessage: USER }).save === false);
ok("a single status sentence is never saved", classifyNote({ text: "Done — the tests pass now.", hasCode: false, userMessage: USER }).save === false);

// Thinly-prompted turn → never (even a long/code answer)
ok("a turn with a <10-word user message is never saved (even with code)", classifyNote({ text: "const x=1;", hasCode: true, userMessage: "fix it" }).save === false);
ok("a turn with a <10-word user message is never saved (even long)", classifyNote({ text: words(400), hasCode: false, userMessage: "make it better" }).save === false);

// Empty response → never
ok("an empty response is never saved", classifyNote({ text: "", hasCode: false, userMessage: USER }).save === false);

// A moderate no-code, no-decision, <300-word answer → not saved (no matching intent)
ok("a mid-length plain answer with no intent is not saved", classifyNote({ text: words(120), hasCode: false, userMessage: USER }).save === false);

// Code beats decision language (fence wins)
ok("a code response with decision words still routes to Code/", classifyNote({ text: "because of X, here is the code:\nconst y=2;", hasCode: true, userMessage: USER }).folder === "Code");

// slug
ok("noteSlug builds a kebab slug from the first line", noteSlug("# Fetch API helper\nmore text") === "fetch-api-helper");
ok("noteSlug caps length and trims dashes", noteSlug("A".repeat(80)).length <= 40);

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

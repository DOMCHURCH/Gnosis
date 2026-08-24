// Verify (design mode): the URL resolver picks the right dev-server URL (explicit
// URL / bare port / single job port / errors when ambiguous), and web-file
// detection decides which edits trigger an auto before/after screenshot.
import { resolveDesignUrl, isWebFile } from "../dist/design.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

// --- resolveDesignUrl -----------------------------------------------------------
ok("an explicit http URL is used verbatim", resolveDesignUrl("http://localhost:3000", []).url === "http://localhost:3000");
ok("an explicit https URL is used verbatim", resolveDesignUrl("https://example.test", [5173]).url === "https://example.test");
ok("a bare port becomes a loopback URL", resolveDesignUrl("5173", []).url === "http://127.0.0.1:5173");
ok("junk arg is rejected with a hint", !!resolveDesignUrl("not-a-url", []).error);

ok("no arg + a single job port → that port", resolveDesignUrl(undefined, [4321]).url === "http://127.0.0.1:4321");
ok("no arg + no ports → error asking for a URL", (() => { const r = resolveDesignUrl(undefined, []); return !r.url && /no dev server/i.test(r.error); })());
ok("no arg + multiple ports → error listing them", (() => { const r = resolveDesignUrl(undefined, [3000, 5173]); return !r.url && /3000/.test(r.error) && /5173/.test(r.error); })());
ok("empty-string arg is treated as no arg", resolveDesignUrl("", [8080]).url === "http://127.0.0.1:8080");

// --- isWebFile ------------------------------------------------------------------
for (const p of ["index.html", "src/App.tsx", "components/Btn.jsx", "styles.css", "a.scss", "site.js", "web/store.ts", "Page.vue", "X.svelte", "home.astro"]) {
  ok(`web file: ${p}`, isWebFile(p) === true);
}
for (const p of ["main.py", "lib.rs", "go.mod", "README.md", "data.json", "Makefile", "notes.txt", "noext"]) {
  ok(`not a web file: ${p}`, isWebFile(p) === false);
}
ok("extension match is case-insensitive", isWebFile("INDEX.HTML") === true);

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

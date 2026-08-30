// Verify (web UI): the app explains itself to someone who has never seen it.
//
// The floor is an isometric office full of desks, labelled "OFFICE FLOOR · CLICK
// AN AGENT" over rooms called "02 PLANNING" and "05 SUB-AGENTS". Every one of
// those is a label rather than an explanation: they answer a question a newcomer
// has not been given enough context to ask. Beside it, an empty chat box.
//
// Three things fix that, and each is asserted here because each is the kind of
// copy that gets "tidied" out later by someone who already knows what the app is:
//   1. a sentence under the floor saying what a desk is,
//   2. a real empty state in the chat instead of a blank box,
//   3. a plain-English line per zone, on hover.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZONES } from "../web/src/sessions.js";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "src");
const read = (f) => readFileSync(path.join(web, f), "utf8");
const floor = read("SessionsFloor.tsx");
const css = read("styles.css");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- 1. the floor says what it is ---------------------------------------------
ok("the floor carries a subtitle", /data-testid="floor-subtitle"/.test(floor));
ok("...saying a desk is an agent", /Each desk is an agent\./.test(floor));
ok("...and how to look at one", /Click one to see what it&rsquo;s doing\./.test(floor));
// The mobile path never sees the 3D floor, so it needs its own copy.
ok("the mobile zone strip says it too", /Each desk is an agent\. Tap a room/.test(floor));

// --- 2. the chat is not a blank box -------------------------------------------
ok("there is an empty state", /data-testid="chat-empty"/.test(floor));
ok("...rendered only when there is nothing to show", /p\.chat\.length === 0 && <ChatEmptyState/.test(floor));
ok("...that says what the agent does", /reads and edits files in your project/.test(floor));
ok("...that it asks first", /asks before[\s\S]{0,40}can&rsquo;t undo/.test(floor));
ok("...and connects the chat to the floor", /one desk per agent/.test(floor));
ok("it offers openers", /const STARTERS = \[/.test(floor));
// Filling the box, not sending. A newcomer's first click must not dispatch an
// agent at their codebase before they have read the prompt.
ok("a starter fills the input rather than sending it", /onClick=\{\(\) => onPick\(s\)\}/.test(floor)
  && /<ChatEmptyState onPick=\{p\.onDraft\}/.test(floor));
ok("...and says so", /put this in the message box/.test(floor));

// --- 3. every zone explains itself --------------------------------------------
for (const z of ZONES) {
  ok(`${z.id} has a plain-English description`, typeof z.what === "string" && z.what.length > 20);
}
// The point is that it reads as English, not as jargon. These are the terms that
// mean nothing to someone who has not read the source.
const JARGON = ["task()", "loadEnv", "CSS2D", "ipcMain", "openrouter", "cwd"];
for (const z of ZONES) {
  const bad = JARGON.filter((j) => z.what.toLowerCase().includes(j.toLowerCase()));
  ok(`${z.id}'s description avoids jargon`, bad.length === 0);
}
// The model must carry `what` through to the view, or none of the above renders.
ok("the zone label model carries it", /what: zone\.what/.test(read("sessions.js")));
ok("the 3D label renders it", /class="zl-what"/.test(read("officeScene.ts")));
ok("...and the label is hoverable at all", /pointer-events: auto/.test(css.split(".zone-label")[1] ?? ""));
ok("...with a tooltip that appears on hover", /\.zone-label:hover \.zl-what/.test(css));
// A tooltip that reflows the label moves the target out from under the cursor.
ok("...positioned out of flow", /\.zone-label \.zl-what \{[\s\S]*?position: absolute;/.test(css));
// The skill's rule: micro-interactions under 250ms.
{
  const m = css.match(/\.zone-label \.zl-what \{[\s\S]*?transition: opacity (\d+)ms/);
  ok("...under 250ms", !!m && Number(m[1]) < 250);
}
ok("the 2D floor explains its zones too", /title=\{z\.what\}/.test(read("FloorGraphic.tsx")));
ok("...and so does the mobile strip", /title=\{z\.what\}/.test(floor));

console.log(fails ? `\n${fails} FAILED` : "\nall newcomer-legibility checks passed");
process.exit(fails ? 1 : 0);

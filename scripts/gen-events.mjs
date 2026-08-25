// Generate the browser's event types from the server's, so there is one wire
// format instead of two hand-maintained copies that drift.
//
// They had already drifted: `security.blocked` existed only on the server, and
// `permission.request.preview` was `unknown` on one side and `Preview` on the
// other — which is why adding `dreamId` to the browser copy silently matched
// nothing and the field went untyped for a whole release.
//
// The bus is deliberately payload-agnostic: src/events.ts types `item`,
// `preview`, and the goal shape loosely because the bus must not couple to them.
// The RENDERER is not agnostic — it draws those payloads. That is the one real
// difference between the two sides, so it lives here as an explicit table rather
// than as a second copy of the whole union.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(root, "src", "events.ts");
const OUT = path.join(root, "web", "src", "events.generated.ts");

/**
 * Fields the browser needs concretely, keyed by `<event type>.<field>`.
 * Each entry names a type the browser already defines in ./types.
 *
 * A refinement that does not apply is a hard error: a renamed or removed field
 * must fail the build loudly, not silently fall back to `unknown`.
 */
const REFINEMENTS = {
  "line.item": { from: "unknown", to: "TranscriptItem" },
  "permission.request.preview": { from: "unknown", to: "Preview" },
  "goal.state.goal": {
    from: "{ text: string; active: boolean; roundsLeft: number; maxRounds: number; reviewModel?: string } | null",
    to: "GoalState | null",
  },
};

/** Browser types the refinements pull in. */
const IMPORTS = ["GoalState", "Preview", "TranscriptItem"];

/** Extract `export type DomEvent = ...` up to the terminating semicolon. */
function extractUnion(source) {
  const start = source.indexOf("export type DomEvent =");
  if (start === -1) throw new Error("could not find `export type DomEvent =` in src/events.ts");
  // The union ends at the first line that closes it with `;` at end of line.
  const rest = source.slice(start);
  const lines = rest.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    out.push(line);
    if (/;\s*$/.test(line) && out.length > 1) break;
  }
  if (!/;\s*$/.test(out[out.length - 1])) throw new Error("DomEvent union is not terminated by `;`");
  return out.join("\n");
}

/** Apply one refinement, failing loudly when the field it names is gone. */
function refine(union, key, { from, to }) {
  const dot = key.lastIndexOf(".");
  const eventType = key.slice(0, dot);
  const field = key.slice(dot + 1);

  const lines = union.split("\n");
  let applied = false;
  const next = lines.map((line) => {
    if (!line.includes(`type: "${eventType}"`)) return line;
    const needle = `${field}: ${from}`;
    if (!line.includes(needle)) return line;
    applied = true;
    return line.replace(needle, `${field}: ${to}`);
  });
  if (!applied) {
    throw new Error(
      `refinement ${key} did not apply — expected \`${field}: ${from}\` on event "${eventType}". ` +
        `The server type changed; update REFINEMENTS in scripts/gen-events.mjs.`,
    );
  }
  return next.join("\n");
}

const source = readFileSync(SOURCE, "utf8");
let union = extractUnion(source);
for (const [key, rule] of Object.entries(REFINEMENTS)) union = refine(union, key, rule);

const body = `// AUTO-GENERATED from src/events.ts — do not edit.
//
// Regenerate with \`npm run gen:events\` (\`npm run build\` does it for you).
// The server's union is the source of truth; the only differences are the
// payload types the renderer needs concretely, declared in scripts/gen-events.mjs.
import type { ${IMPORTS.join(", ")} } from "./types";

${union}
`;

mkdirSync(path.dirname(OUT), { recursive: true });

// Only write when the content actually changes, so a no-op build does not churn
// the file's mtime and retrigger watchers.
let previous = "";
try {
  previous = readFileSync(OUT, "utf8");
} catch {
  /* first run */
}
if (previous !== body) {
  writeFileSync(OUT, body, "utf8");
  console.log(`gen-events: wrote ${path.relative(root, OUT)}`);
} else {
  console.log("gen-events: up to date");
}

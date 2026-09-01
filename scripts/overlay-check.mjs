// `npm run overlay:check` — the same diagnostic the packaged app exposes, run
// from the source tree.
//
// It is a launcher rather than a script of its own so that there is exactly ONE
// diagnostic: electron/overlay-diagnostic.js, reached through main.js's env-var
// gate. A second copy here would drift, and a diagnostic that has drifted from
// the thing it diagnoses is worse than none.
//
// The packaged form is the one that actually settles the question — see the note
// on the gate in main.js — but this is the fast loop while iterating.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "node_modules", "electron", "dist",
  process.platform === "win32" ? "electron.exe" : "electron");

console.log("launching the overlay diagnostic from source — press Q or Esc in it to quit\n");
const r = spawnSync(bin, [path.join(root, "electron", "main.js")], {
  stdio: "inherit",
  cwd: root,
  env: { ...process.env, GNOSIS_OVERLAY_DIAGNOSTIC: "1" },
});
process.exit(r.status ?? 0);

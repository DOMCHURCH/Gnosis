// Apply the schema, then exit. Run by `npm run migrate`.
//
// The server also migrates on boot, so this exists for the case where you want
// to set the table up — or confirm it is set up — without starting anything.

import { migrate, closePool } from "./db.js";

try {
  await migrate();
  console.log("schema applied");
} catch (err) {
  console.error("migration failed:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await closePool().catch(() => {});
}

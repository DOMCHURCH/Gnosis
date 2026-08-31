// The acceptance endpoint.
//
// One route that matters: POST /accept. It exists so that the record of who
// agreed to the Terms is not held solely by the person who agreed.
//
// WHAT THIS DELIBERATELY IS NOT: it is not analytics. There is no event stream,
// no heartbeat, no usage reporting, and no second call of any kind. The client
// contacts this service exactly once per accepted document and never again. The
// Terms say that, so the code has to mean it.

import Fastify from "fastify";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateAcceptance } from "./validate.js";
import { insertAcceptance, migrate, closePool } from "./db.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = "0.0.0.0"; // Railway routes to the container's external interface.

export function buildServer({ insert = insertAcceptance, logger = true } = {}) {
  const app = Fastify({
    logger,
    // The payload is six short fields. Anything larger is not an acceptance.
    bodyLimit: 16 * 1024,
    trustProxy: true,
  });

  // Railway's healthcheck, and a cheap way to confirm a deploy is live.
  app.get("/health", async () => ({ ok: true }));

  app.post("/accept", async (request, reply) => {
    const result = validateAcceptance(request.body);
    if (!result.ok) {
      // 400 is meaningful to the client: it stops retrying on a 4xx, because a
      // malformed payload will not become well-formed by being sent again.
      return reply.code(400).send({ ok: false, error: result.error });
    }

    try {
      const { id, created } = await insert(result.value);
      // 200 for both a new row and an existing one. "Already recorded" is the
      // correct end state for a retry, not an error — see insertAcceptance.
      return reply.code(200).send({ ok: true, id, created });
    } catch (err) {
      request.log.error({ err }, "failed to record acceptance");
      // 5xx tells the client to keep the payload queued and try again later. An
      // acceptance lost to a database blip is an acceptance that never happened
      // as far as the record is concerned, so the client must not give up.
      return reply.code(503).send({ ok: false, error: "could not record; retry later" });
    }
  });

  return app;
}

// Only start listening when run directly, so tests can import buildServer.
// Compared as resolved file URLs because a bare string comparison gets the
// answer wrong on Windows, where argv[1] is a backslash path and import.meta.url
// is a file:// URL.
const runDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (runDirectly) {
  const app = buildServer();
  try {
    await migrate();
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    app.log.error(err);
    await closePool().catch(() => {});
    process.exit(1);
  }

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => {
      await app.close().catch(() => {});
      await closePool().catch(() => {});
      process.exit(0);
    });
  }
}

// Verify (serve: compression) — the single-file UI is gzipped to clients that
// ask for it, and byte-identical to the uncompressed body.
//
// Why this is worth a suite of its own: the frontend is inlined into ONE file by
// viteSingleFile — index.html carries the whole app, three.js included, at
// roughly 1.6MB. The reason `dom serve` binds the LAN at all is so a phone on
// the same WiFi can open it, and that phone was downloading every one of those
// bytes uncompressed on each cold load.
//
// The properties that have to hold, and each is a way compression goes wrong:
//
//   - a client that did NOT offer gzip must still get a working body. Sending a
//     compressed payload to a client that cannot decode it is not a slow page,
//     it is a broken one.
//   - the decompressed bytes must equal the uncompressed response exactly. A
//     transfer encoding that changes content is a corruption bug wearing an
//     optimisation's clothes.
//   - `Vary: Accept-Encoding` must be set, or a cache between the phone and the
//     server will hand a gzipped body to the next client that asked for plain.
import http from "node:http";
import zlib from "node:zlib";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { EventBus, createBridge } = await import("../dist/events.js");
const { startServer } = await import("../dist/server.js");

let fails = 0;
const ok = (n, c, extra = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${extra ? ` — ${extra}` : ""}`); if (!c) fails++; };

const bus = new EventBus();
const bridge = createBridge(bus);
bridge.getAgents = () => [];
const server = await startServer(bridge, { port: 0 });

/** GET /, optionally advertising gzip. Returns headers + raw body bytes. */
function get({ gzip: wantGzip }) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.port,
        path: `/?token=${server.token}`,
        method: "GET",
        headers: wantGzip ? { "accept-encoding": "gzip" } : { "accept-encoding": "identity" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", () => resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }));
    req.end();
  });
}

const plain = await get({ gzip: false });
const packed = await get({ gzip: true });

ok("a client that does not accept gzip gets 200", plain.status === 200);
ok("...and an uncompressed body", !plain.headers["content-encoding"]);

ok("a client that accepts gzip gets 200", packed.status === 200);

// The placeholder page served when there is no built frontend is under the 1KB
// floor, so compression correctly declines it. Only assert the compressed path
// when the body was actually big enough to qualify.
const qualifies = plain.body.length >= 1024;
if (!qualifies) {
  console.log(`SKIP body is ${plain.body.length}B (< 1KB floor) — no built frontend present to compress`);
} else {
  ok("...and a gzipped body", packed.headers["content-encoding"] === "gzip");
  ok("...marked Vary: Accept-Encoding so caches cannot cross the wires",
    String(packed.headers["vary"] ?? "").toLowerCase().includes("accept-encoding"));

  const round = zlib.gunzipSync(packed.body);
  ok("...that decompresses to EXACTLY the uncompressed body", round.equals(plain.body));
  ok("...and is actually smaller", packed.body.length < plain.body.length,
    `${plain.body.length}B → ${packed.body.length}B`);
}

// A body below the floor must never come back gzipped: the header overhead and
// the trip through zlib cost more than the bytes saved.
if (!qualifies) {
  ok("a sub-1KB body is not compressed", packed.headers["content-encoding"] === undefined);
}

await server.close?.();
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

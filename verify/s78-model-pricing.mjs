// Verify (model picker pricing): every picker row carries a price, a tier and a
// context window; a provider that publishes no prices is labelled "price n/a"
// rather than "free"; and the hint survives the overlay.open wire hop into the
// browser — which is where it was being dropped.
import net from "node:net";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { modelTier, priceLabel, contextLabel, modelHint, buildModelPickItems } = await import("../dist/models.js");
const { EventBus, createBridge } = await import("../dist/events.js");
const { startServer } = await import("../dist/server.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

const entry = (over) => ({
  id: "x/y", name: "Y", context_length: 200000,
  pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 },
  supported_parameters: ["tools"], input_modalities: ["text"], ...over,
});

// --- tiers --------------------------------------------------------------------
const paid = entry({ id: "anthropic/claude-sonnet-4.6", pricingKnown: true, pricing: { prompt: 0.000003, completion: 0.000015, cacheRead: 0, cacheWrite: 0 } });
const free = entry({ id: "meta/llama:free", pricingKnown: true });
const groq = entry({ id: "groq/llama-3.3-70b" }); // Groq publishes no prices at all
const fb = entry({ id: "openai/gpt-4o-mini" });   // offline fallback list

ok("a priced model is paid", modelTier(paid) === "paid");
ok("a zero-priced model the catalog priced is free", modelTier(free) === "free");
ok("a Groq model is unknown, NOT free", modelTier(groq) === "unknown");
ok("an offline-fallback model is unknown, NOT free", modelTier(fb) === "unknown");

// --- labels -------------------------------------------------------------------
ok("a paid model quotes both directions per 1M", priceLabel(paid) === "$3.00/$15.00 per 1M in/out");
ok("a free model says free", priceLabel(free) === "free");
ok("an unpriced model says price n/a", priceLabel(groq) === "price n/a");
ok("an unpriced model never renders as $0.00", !priceLabel(groq).includes("0.00"));

const cheap = entry({ id: "c", pricingKnown: true, pricing: { prompt: 0.00000002, completion: 0.0000001, cacheRead: 0, cacheWrite: 0 } });
ok("a sub-cent price keeps enough digits to stay distinct", priceLabel(cheap).includes("0.02") && priceLabel(cheap).includes("0.1"));

ok("200000 renders as 200K ctx", contextLabel(entry({})) === "200K ctx");
ok("1000000 renders as 1M ctx", contextLabel(entry({ context_length: 1000000 })) === "1M ctx");
ok("an unknown context window renders nothing", contextLabel(entry({ context_length: 0 })) === "");
ok("the hint joins price and context", modelHint(paid) === "$3.00/$15.00 per 1M in/out · 200K ctx");
ok("the hint omits the separator when the context is unknown", modelHint(entry({ context_length: 0, pricingKnown: true })) === "free");

// --- picker rows (the ONE builder both surfaces use) --------------------------
const rows = buildModelPickItems([paid, free, groq]);
ok("every row has a non-empty hint", rows.every((r) => typeof r.hint === "string" && r.hint.length > 0));
ok("every row has a tier", rows.every((r) => ["free", "paid", "unknown"].includes(r.tier)));
ok("the row value is the model id (what /model applies)", rows[0].value === "anthropic/claude-sonnet-4.6");
ok("the tier is searchable so typing 'free' narrows", rows[1].search.includes("free"));
ok("a paid row is not searchable as free", !rows[0].search.includes("free"));

// --- the wire hop: overlay.open must not strip the hint -----------------------
const bus = new EventBus();
const bridge = createBridge(bus);
bridge.getAgents = () => [{ id: 1, name: "main", cwd: "/x", model: "m", mode: "ask", busy: false }];
const server = await startServer(bridge, { port: 0 });

function decodeServerFrames(buf, onText) {
  let off = 0;
  while (buf.length - off >= 2) {
    const opcode = buf[off] & 0x0f;
    let len = buf[off + 1] & 0x7f;
    let p = off + 2;
    if (len === 126) { if (buf.length - off < 4) break; len = buf.readUInt16BE(off + 2); p = off + 4; }
    else if (len === 127) { if (buf.length - off < 10) break; len = Number(buf.readBigUInt64BE(off + 2)); p = off + 10; }
    if (buf.length - p < len) break;
    onText(buf.subarray(p, p + len).toString("utf8"));
    off = p + len;
  }
  return buf.subarray(off);
}

function wsConnect(token) {
  return new Promise((resolve) => {
    const socket = net.connect(server.port, "127.0.0.1", () => {
      const key = crypto.randomBytes(16).toString("base64");
      socket.write(
        `GET /ws?token=${token} HTTP/1.1\r\nHost: localhost:${server.port}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const messages = [];
    const waiters = [];
    const api = {
      next: () => new Promise((r) => { const m = messages.shift(); if (m !== undefined) r(m); else waiters.push(r); }),
      close: () => socket.destroy(),
    };
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        upgraded = true;
        buf = buf.subarray(idx + 4);
        resolve(api);
      }
      buf = decodeServerFrames(buf, (t) => { const w = waiters.shift(); if (w) w(t); else messages.push(t); });
    });
    socket.on("error", () => {});
  });
}

const client = await wsConnect(server.token);
bus.emit({ type: "overlay.open", tabId: 1, id: "overlay:1:1", kind: "model", title: "select model", items: rows, selected: rows[0].value });

let open = null;
for (let i = 0; i < 20 && !open; i++) {
  const m = JSON.parse(await client.next());
  if (m.type === "overlay.open") open = m;
}
ok("the browser receives the model overlay", !!open);
ok("...with the price hint intact", !!open && open.items[0].hint === modelHint(paid));
ok("...with the tier intact (so the UI can split free/paid)", !!open && open.items[0].tier === "paid" && open.items[1].tier === "free");
ok("...for every row, not just the first", !!open && open.items.every((it) => typeof it.hint === "string" && it.hint.length > 0));

client.close();
await server.close();
try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

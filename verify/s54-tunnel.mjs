// Verify (tunnel URL parsing): the public trycloudflare URL is extracted from
// cloudflared's log stream, and non-matching output yields null. (Spawning a real
// tunnel needs the network + binary, so only the parser is unit-tested here.)
import { parseTunnelUrl } from "../dist/tunnel.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const log = [
  "2026-08-24T00:00:00Z INF Thank you for trying Cloudflare Tunnel.",
  "2026-08-24T00:00:01Z INF +--------------------------------------+",
  "2026-08-24T00:00:01Z INF |  Your quick Tunnel has been created! |",
  "2026-08-24T00:00:01Z INF |  https://brave-otter-1234.trycloudflare.com  |",
  "2026-08-24T00:00:01Z INF +--------------------------------------+",
].join("\n");

ok("extracts the trycloudflare URL from the log block", parseTunnelUrl(log) === "https://brave-otter-1234.trycloudflare.com");
ok("extracts from a single inline line", parseTunnelUrl("registered tunnel at https://xy-z-9.trycloudflare.com now") === "https://xy-z-9.trycloudflare.com");
ok("is case-insensitive on the scheme/host", parseTunnelUrl("HTTPS://ABC.TRYCLOUDFLARE.COM") === "HTTPS://ABC.TRYCLOUDFLARE.COM");
ok("returns null before any URL appears", parseTunnelUrl("2026 INF starting metrics server on 127.0.0.1:20241") === null);
ok("returns null for empty output", parseTunnelUrl("") === null);
ok("ignores a non-trycloudflare https URL", parseTunnelUrl("see https://dash.cloudflare.com/login") === null);

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

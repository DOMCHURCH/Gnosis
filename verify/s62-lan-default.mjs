// Verify (LAN QR by default): `dom serve` / `/serve` reach the LAN with no flag.
// The Host-header gate must accept loopback AND private LAN IPv4s always (a phone
// on the same WiFi connects by IP), while still refusing any public hostname so the
// DNS-rebinding defense holds. The `--lan` flag is gone: parseArgs must not know it,
// and startServer must not take it. Access control is the per-startup token, which
// still applies to every connection — reachability alone grants nothing.
//
// Runs against dist/, i.e. the modules the real `dom serve` binary loads.
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const imp = (f) => import(pathToFileURL(path.resolve(here, f)).href);
const { hostOk, startServer } = await imp("../dist/server.js");
const { parseArgs } = await imp("../dist/startup.js");
const { lanIp, isPrivateIpv4 } = await imp("../dist/netip.js");
const { createBridge } = await imp("../dist/events.js");
const { EventBus } = await imp("../dist/events.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- the Host gate accepts LAN with no flag ----------------------------------
ok("loopback names are always accepted",
  hostOk("127.0.0.1:7777") && hostOk("localhost:7777") && hostOk("[::1]:7777"));
ok("private LAN IPv4s are accepted with NO flag (the whole point of this change)",
  hostOk("192.168.2.229:7777") && hostOk("10.0.0.5:7777") && hostOk("172.16.4.1:7777") && hostOk("169.254.1.1:7777"));
ok("hostOk takes no allowLan argument any more", hostOk.length === 1);
ok("public hostnames are still refused (DNS rebinding stays blocked)",
  !hostOk("evil.example.com:7777") && !hostOk("8.8.8.8:7777") && !hostOk("172.32.0.1:7777"));
ok("a missing Host header is refused", !hostOk(undefined) && !hostOk(""));

ok("isPrivateIpv4 covers the four private/link-local ranges",
  isPrivateIpv4("10.1.2.3") && isPrivateIpv4("192.168.0.1") && isPrivateIpv4("172.20.0.1") && isPrivateIpv4("169.254.9.9")
  && !isPrivateIpv4("172.15.0.1") && !isPrivateIpv4("172.32.0.1") && !isPrivateIpv4("8.8.8.8"));

// The prefix regexes match TEXT, not structure — unanchored, "10." matches the
// START of a hostname just as readily as a real IPv4, which would read an
// attacker's own domain as "private" (i.e. trusted by hostOk's DNS-rebinding
// defense) purely because it happens to start with a private-range prefix.
ok("isPrivateIpv4 rejects a hostname merely PREFIXED like a private range",
  !isPrivateIpv4("10.evil.com") && !isPrivateIpv4("192.168.1.1.attacker.example.com") &&
  !isPrivateIpv4("172.16.attacker.io") && !isPrivateIpv4("169.254.evil.net"));
ok("...and hostOk agrees — refuses the same hostnames dressed up as a Host header",
  !hostOk("10.evil.com:7777") && !hostOk("192.168.1.1.attacker.example.com:7777") && !hostOk("172.16.attacker.io:7777"));

// --- the --lan flag is gone --------------------------------------------------
const flags = parseArgs(["serve", "--lan"]);
ok("parseArgs no longer sets a lan flag", flags.lan === undefined);
ok("`serve` itself still parses", parseArgs(["serve"]).serve === true);
ok("`--public` and `--port` still parse", (() => {
  const f = parseArgs(["serve", "--public", "--port", "8123"]);
  return f.serve === true && f.public === true && f.port === 8123;
})());
ok("startServer takes a bridge plus one defaulted options bag (no lan argument)", startServer.length === 1);

/** A raw request so the Host header is ours to set — fetch() forbids overriding it. */
function rawGet(port, pathname, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method: "GET", headers: { Host: host } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

// --- a real server, started with no flags, is LAN-reachable ------------------
const bridge = createBridge(new EventBus());
const server = await startServer(bridge, { port: 0 });
try {
  ok("the LOCAL url is the tokenized loopback url",
    server.url.startsWith(`http://127.0.0.1:${server.port}/?token=`) && server.url.includes(server.token));

  const lan = lanIp();
  if (lan) {
    ok("a LAN url is produced with no flag at all", server.lanUrl === `http://${lan}:${server.port}`);
    ok("the LAN url carries the SAME token gate as LOCAL",
      hostOk(`${lan}:${server.port}`) && server.token.length > 0);
    console.log(`     (this machine's LAN address: ${lan})`);
  } else {
    ok("no LAN address on this machine, so lanUrl is null", server.lanUrl === null);
    console.log("     (no non-loopback interface here — LAN url correctly omitted)");
  }

  // The token gate is what protects the now-LAN-reachable server: an untokenized
  // request must be refused even though the Host is allowed.
  const res = await fetch(`http://127.0.0.1:${server.port}/api/serveinfo`);
  ok("a request without the token is refused (401/403), LAN or not", res.status === 401 || res.status === 403);
  const good = await fetch(`http://127.0.0.1:${server.port}/api/serveinfo?token=${server.token}`);
  ok("a tokenized request is served", good.status === 200);
  const info = await good.json();
  ok("/api/serveinfo reports the LAN url to the browser (for its QR)",
    Object.prototype.hasOwnProperty.call(info, "lan") && info.lan === server.lanUrl);
  ok("a rebinding Host is refused even with a valid token",
    (await rawGet(server.port, `/api/serveinfo?token=${server.token}`, "evil.example.com")) !== 200);
  ok("a LAN-shaped Host is accepted with a valid token (what a scanning phone sends)",
    (await rawGet(server.port, `/api/serveinfo?token=${server.token}`, `192.168.2.229:${server.port}`)) === 200);
} finally {
  await server.close();
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
// Not process.exit(): this suite is the one real net.Server + fetch() combo in
// the fleet, and forcing an immediate exit races libuv's own handle-closing
// on Windows (fetch's undici socket teardown vs. the just-awaited
// server.close()), surfacing as "Assertion failed:
// !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76" AFTER
// every assertion above has already passed. Setting exitCode and letting the
// event loop drain avoids tearing down a handle mid-close.
process.exitCode = fails ? 1 : 0;

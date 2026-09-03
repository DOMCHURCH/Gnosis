// LAN address helpers for `dom serve --lan`: find the machine's private IPv4 so a
// phone on the same WiFi can reach the web UI (127.0.0.1 is only reachable on the
// desktop itself). Detection only — binding + the Host allowlist live in server.ts.

import os from "node:os";
import net from "node:net";

/** True for a private / link-local IPv4 (the ranges a LAN device would connect on). */
export function isPrivateIpv4(host: string): boolean {
  // The prefix regexes below match on TEXT, not structure — unanchored, "10."
  // matches the start of "10.evil.com" just as readily as "10.1.2.3", which
  // silently broke the DNS-rebinding defense server.ts's hostOk() relies on
  // this for (an attacker's own domain resolving/pointing at any hostname
  // starting with a private-range prefix would read as "private", i.e.
  // trusted). net.isIPv4 requires a real 4-octet dotted-decimal address
  // first, so nothing with a hostname tacked on can reach the prefix checks.
  if (!net.isIPv4(host)) return false;
  return /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host);
}

/** The machine's LAN IPv4: a private, non-internal address (WiFi/Ethernet). null
 * when there is none — loopback-only, or a host whose only address is public.
 *
 * Deliberately no fallback to a non-private address. hostOk() in server.ts accepts
 * loopback plus isPrivateIpv4 and nothing else, so any address this returns that
 * the allowlist would reject becomes a QR code pointing at a URL the server itself
 * answers with 403 — which is what a cloud VM or container with only a public IPv4
 * would have printed. The two must agree on what "LAN" means; this is that
 * agreement, and it fails closed by advertising no LAN url at all. */
export function lanIp(): string | null {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      if (isPrivateIpv4(ni.address)) return ni.address;
    }
  }
  return null;
}

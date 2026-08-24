// LAN address helpers for `dom serve --lan`: find the machine's private IPv4 so a
// phone on the same WiFi can reach the web UI (127.0.0.1 is only reachable on the
// desktop itself). Detection only — binding + the Host allowlist live in server.ts.

import os from "node:os";

/** True for a private / link-local IPv4 (the ranges a LAN device would connect on). */
export function isPrivateIpv4(host: string): boolean {
  return /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host);
}

/** The machine's LAN IPv4: prefer a private, non-internal address (WiFi/Ethernet),
 * falling back to any non-internal IPv4. null when only loopback exists. */
export function lanIp(): string | null {
  const ifaces = os.networkInterfaces();
  let fallback: string | null = null;
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      if (isPrivateIpv4(ni.address)) return ni.address;
      fallback ??= ni.address;
    }
  }
  return fallback;
}

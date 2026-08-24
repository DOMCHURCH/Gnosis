// Terminal rendering for `dom serve` URLs: each URL followed by its scannable QR
// code. Shared by the CLI startup print and the in-session /serve logger so the two
// look identical.

import { qrTerminal } from "./qr.js";

export interface ServeLink {
  label: string;
  url: string;
}

/** URL line + QR for each link, joined — ready for stdout or a TUI line logger. */
export async function serveBlock(links: ServeLink[]): Promise<string> {
  const parts: string[] = [];
  for (const l of links) {
    parts.push(`${l.label}  ${l.url}`);
    const qr = await qrTerminal(l.url);
    if (qr) parts.push(qr.replace(/\n$/, ""));
  }
  return parts.join("\n");
}

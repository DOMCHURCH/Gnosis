// Terminal rendering for `gnosis serve` URLs: the URL lines, plus ONE scannable QR
// code. Shared by the CLI startup print and the in-session /serve logger so the two
// look identical.

import { qrTerminal } from "./qr.js";

export interface ServeLink {
  label: string;
  url: string;
  /** Eligible to carry the single QR. LOCAL sets this false: a loopback URL is
   *  useless on a phone, which is the only thing that scans it. */
  scannable?: boolean;
}

/** The one link worth scanning: LAN if we have it, else a public tunnel. Returns
 *  undefined when only loopback exists, in which case no QR is drawn at all. */
function qrTarget(links: ServeLink[]): ServeLink | undefined {
  return links.find((l) => l.scannable !== false);
}

/** URL lines + a single QR, joined — ready for stdout or a TUI line logger. */
export async function serveBlock(links: ServeLink[]): Promise<string> {
  const target = qrTarget(links);
  const parts: string[] = [];
  for (const l of links) {
    parts.push(`${l.label}  ${l.url}`);
    if (l !== target) continue;
    const qr = await qrTerminal(l.url);
    if (qr) parts.push(qr.replace(/\n$/, ""));
  }
  return parts.join("\n");
}

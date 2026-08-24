// Design mode helpers (pure, unit-tested). `/design` screenshots a running dev
// server and injects it into the next turn as a vision block; while design mode is
// on, each edit to a web file triggers an auto before/after screenshot. The browser
// launch itself lives in screenshot.ts; this module only decides the URL and which
// edits count as "web files".

/** Resolve the dev-server URL for /design. An explicit arg (a full URL or a bare
 * port) wins; else a single port-bound background job; else null with a hint. */
export function resolveDesignUrl(arg: string | undefined, ports: number[]): { url?: string; error?: string } {
  const a = (arg ?? "").trim();
  if (a) {
    if (/^https?:\/\//i.test(a)) return { url: a };
    if (/^\d{2,5}$/.test(a)) return { url: `http://127.0.0.1:${a}` };
    return { error: `not a URL or port: "${a}" — try /design http://localhost:3000 or /design 5173` };
  }
  if (ports.length === 1) return { url: `http://127.0.0.1:${ports[0]}` };
  if (ports.length === 0) return { error: "no dev server detected (no background job bound to a port) — pass a URL: /design http://localhost:3000" };
  return { error: `multiple servers on ports ${ports.join(", ")} — pass one: /design ${ports[0]}` };
}

// Front-end file extensions whose edits change the rendered UI. Design mode is
// opt-in and scoped to a running web app, so the set is deliberately inclusive.
const WEB_EXT = new Set([".html", ".htm", ".css", ".scss", ".sass", ".less", ".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte", ".astro"]);

/** Whether an edited path is a web file whose change should trigger an auto-shot. */
export function isWebFile(p: string): boolean {
  const s = p.toLowerCase();
  const dot = s.lastIndexOf(".");
  if (dot < 0) return false;
  return WEB_EXT.has(s.slice(dot));
}

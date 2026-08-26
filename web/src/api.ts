// Shared token + fetch helpers for the token-gated read APIs (/api/tree, /api/file,
// /api/vault/*). The token rides in the query string, same as the WebSocket connect.

export function token(): string {
  return new URLSearchParams(location.search).get("token") ?? "";
}

/** GET a JSON endpoint with the auth token appended. Returns null on any failure. */
export async function apiGet<T>(path: string, params: Record<string, string | number> = {}): Promise<T | null> {
  const q = new URLSearchParams({ token: token(), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  try {
    const res = await fetch(`${path}?${q.toString()}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** POST a JSON body to a token-gated endpoint. Returns the parsed JSON or null. */
export async function apiPost<T>(path: string, body: unknown): Promise<T | null> {
  const q = new URLSearchParams({ token: token() });
  try {
    const res = await fetch(`${path}?${q.toString()}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** The full tokenized URL for a base origin (e.g. for a QR code). */
export function tokenizedUrl(base: string): string {
  return `${base.replace(/\/$/, "")}/?token=${token()}`;
}

/** Token-gated URL for one file under a tab's root. `raw` fetches the bytes
 *  (images, PDFs); otherwise the JSON text preview the file browser uses. */
export function fileUrlFor(tabId: number, path: string, raw: boolean): string {
  // Tool screenshots live in ~/.dom/screenshots, which is outside every session
  // root — /api/file/raw refuses those by design, and that guard should stay as
  // strict as it is. They have their own basename-only endpoint instead.
  const shot = screenshotName(path);
  if (shot) return `/api/screenshot?${new URLSearchParams({ token: token(), name: shot }).toString()}`;
  const q = new URLSearchParams({ token: token(), tabId: String(tabId), path });
  return `${raw ? "/api/file/raw" : "/api/file"}?${q.toString()}`;
}

/** The basename when `p` points into ~/.dom/screenshots, else null. Matches both
 * separators, since the path is produced server-side on whatever OS is running. */
export function screenshotName(p: string): string | null {
  const norm = String(p || "").split("\\").join("/");
  const m = /\/\.dom\/screenshots\/([^/]+)$/.exec(norm);
  return m ? m[1] : null;
}

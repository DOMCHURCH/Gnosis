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

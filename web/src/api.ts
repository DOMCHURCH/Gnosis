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

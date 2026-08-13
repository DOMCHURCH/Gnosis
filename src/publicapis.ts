// Code-maintained cache for the public-apis index. The README is ~200KB — larger
// than the http tool is willing to hand back — so the fetch + write happen here,
// writing the FULL file to ~/.dom/cache/public-apis.md. The public-apis skill
// then greps that file by category. Refreshed at most once every 30 days (mtime).

import { promises as fs } from "node:fs";
import { cacheDir } from "./config.js";
import path from "node:path";

export const PUBLIC_APIS_URL =
  "https://raw.githubusercontent.com/public-apis/public-apis/master/README.md";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function publicApisCachePath(): string {
  return path.join(cacheDir(), "public-apis.md");
}

export interface CacheResult {
  path: string;
  refreshed: boolean;
  /** Age (days) of the cache being used; null when freshly written or absent. */
  ageDays: number | null;
  /** Set when a refresh was attempted but failed (any prior cache is kept). */
  error?: string;
}

async function fileAgeMs(p: string): Promise<number | null> {
  try {
    const st = await fs.stat(p);
    return Date.now() - st.mtimeMs;
  } catch {
    return null; // absent
  }
}

/**
 * Ensure ~/.dom/cache/public-apis.md exists and is < 30 days old, fetching the
 * full README when missing or stale. Never throws: on a fetch failure it keeps
 * any existing (stale) cache and reports the error. `fetchImpl` is injectable
 * for tests.
 */
export async function ensurePublicApisCache(
  opts: { force?: boolean; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<CacheResult> {
  const p = publicApisCachePath();
  const ageMs = await fileAgeMs(p);
  const fresh = ageMs !== null && ageMs < MAX_AGE_MS;
  if (fresh && !opts.force) {
    return { path: p, refreshed: false, ageDays: Math.floor(ageMs / 86_400_000) };
  }

  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(PUBLIC_APIS_URL, { signal: opts.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = await res.text();
    if (!body.trim()) throw new Error("empty response");
    await fs.mkdir(cacheDir(), { recursive: true });
    await fs.writeFile(p, body, "utf8");
    return { path: p, refreshed: true, ageDays: null };
  } catch (e) {
    return {
      path: p,
      refreshed: false,
      ageDays: ageMs !== null ? Math.floor(ageMs / 86_400_000) : null,
      error: (e as Error).message,
    };
  }
}

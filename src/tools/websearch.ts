// web_search: query the Brave Search API and return the top results (title, URL,
// snippet). The key is read from ~/.dom/.env as BRAVE_API_KEY (the same env file
// the http tool uses for ${VAR} secrets). Pairs with the http tool: search here to
// find pages, then fetch a specific one with http.

import { loadEnv, envPath } from "./http.js";
import { truncateOutput } from "./truncate.js";
import type { WebSearchArgs } from "./schemas.js";
import type { ToolResult } from "./index.js";

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_COUNT = 8;
const MAX_COUNT = 20;
const TIMEOUT_MS = 20_000;

/** Strip HTML tags and decode the handful of entities Brave puts in snippets. */
function clean(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function composeSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  if (!signal) return timeout;
  if (typeof (AbortSignal as any).any === "function") return (AbortSignal as any).any([signal, timeout]);
  return signal;
}

export async function runWebSearch(args: WebSearchArgs, signal?: AbortSignal): Promise<ToolResult> {
  const env = await loadEnv();
  const key = env.BRAVE_API_KEY;
  if (!key) {
    return {
      output:
        `web_search: no BRAVE_API_KEY set. Add a line \`BRAVE_API_KEY=<your key>\` to ${envPath()} ` +
        `(get a free key at https://brave.com/search/api/).`,
      isError: true,
    };
  }

  const count = Math.min(Math.max(args.count ?? DEFAULT_COUNT, 1), MAX_COUNT);
  const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(args.query)}&count=${count}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": key },
      signal: composeSignal(signal),
    });
  } catch (e) {
    if (signal?.aborted) return { output: "■ aborted", isError: true, aborted: true };
    if ((e as Error).name === "TimeoutError") return { output: `web_search: request timed out after ${TIMEOUT_MS / 1000}s`, isError: true };
    return { output: `web_search: ${(e as Error).message}`, isError: true };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      return { output: `web_search: Brave rejected the API key (${res.status}). Check BRAVE_API_KEY in ${envPath()}.`, isError: true };
    }
    if (res.status === 429) return { output: "web_search: rate limited by Brave (429) — wait a moment and retry.", isError: true };
    return { output: `web_search: Brave API error ${res.status}: ${body.slice(0, 200)}`, isError: true };
  }

  let data: any;
  try {
    data = await res.json();
  } catch (e) {
    return { output: `web_search: unreadable response from Brave: ${(e as Error).message}`, isError: true };
  }

  const results: any[] = Array.isArray(data?.web?.results) ? data.web.results : [];
  if (!results.length) return { output: `No results for "${args.query}".`, isError: false };

  const shown = results.slice(0, count);
  const lines = shown.map((r, i) => {
    const title = clean(String(r.title ?? "")) || "(untitled)";
    const link = String(r.url ?? "");
    const snippet = clean(String(r.description ?? ""));
    return `${i + 1}. ${title}\n   ${link}${snippet ? `\n   ${snippet}` : ""}`;
  });
  const header = `${shown.length} result${shown.length === 1 ? "" : "s"} for "${args.query}":`;
  return { output: truncateOutput(`${header}\n\n${lines.join("\n\n")}`), isError: false };
}

// The http tool: make an outbound HTTP(S) request. Guarded against SSRF (no
// loopback/private/metadata hosts, http/https only), substitutes ${VAR} secrets
// from ~/.dom/.env at request time WITHOUT ever letting a key reach message
// history or the transcript (Authorization/api-key are shown as <redacted>, and
// the echoed request uses the model's original ${VAR} text, never the value).

import net from "node:net";
import { lookup as realDnsLookup } from "node:dns/promises";
import { loadEnv, envPath } from "../config.js";
import { truncateOutput } from "./truncate.js";
import type { HttpArgs } from "./schemas.js";
import type { ToolResult } from "./index.js";

const DEFAULT_TIMEOUT_S = 30;
const MAX_REDIRECTS = 5;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Header names whose values must never be shown — redacted to <redacted>. */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "api-key",
  "x-api-key",
  "x-auth-token",
  "cookie",
  "set-cookie",
]);

export function normalizeMethod(method: unknown): string {
  const m = String(method ?? "GET").trim().toUpperCase();
  return m || "GET";
}

// loadEnv/envPath live in config.ts (one key file shared with OpenRouter auth);
// re-exported here so tool code (and web_search) can keep importing from ./http.
export { loadEnv, envPath };

// --- SSRF / scheme guard ----------------------------------------------------
//
// Address ranges are enforced with node:net's BlockList rather than hand-rolled
// regex. This matters specifically for IPv6: BlockList#check() correctly
// resolves an IPv4-mapped IPv6 literal (::ffff:127.0.0.1, and any of its many
// equivalent compressed forms, e.g. what new URL() actually normalizes it to:
// "::ffff:7f00:1") against the ipv4 rules below — verified empirically, since a
// naive regex on the literal text (the previous approach) only ever matches the
// one exact spelling it was written against and lets every other valid
// spelling of the same address through. The bare "::/96" rule additionally
// catches the deprecated IPv4-compatible form (::a.b.c.d, no ffff marker),
// which BlockList does not special-case on its own — that /96 does not
// overlap ::ffff:0:0/96 (verified), so real IPv4-mapped public addresses are
// unaffected.
const BLOCKED = new net.BlockList();
BLOCKED.addSubnet("0.0.0.0", 8, "ipv4"); // 0.0.0.0/8
BLOCKED.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
BLOCKED.addSubnet("10.0.0.0", 8, "ipv4"); // private
BLOCKED.addSubnet("172.16.0.0", 12, "ipv4"); // private
BLOCKED.addSubnet("192.168.0.0", 16, "ipv4"); // private
BLOCKED.addSubnet("169.254.0.0", 16, "ipv4"); // link-local incl. 169.254.169.254 metadata
BLOCKED.addSubnet("::1", 128, "ipv6"); // loopback
BLOCKED.addSubnet("::", 128, "ipv6"); // unspecified
BLOCKED.addSubnet("fe80::", 10, "ipv6"); // link-local
BLOCKED.addSubnet("fc00::", 7, "ipv6"); // unique-local
BLOCKED.addSubnet("::", 96, "ipv6"); // deprecated IPv4-compatible ::a.b.c.d/96

/** Is this hostname (already resolved to a literal IP) a loopback / private /
 * link-local / cloud-metadata address? Hostnames that are not IP literals
 * return false here — see resolvedHostBlockReason for the DNS-aware check. */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (net.isIPv4(h)) return BLOCKED.check(h, "ipv4");
  if (net.isIPv6(h)) return BLOCKED.check(h, "ipv6");
  return false;
}

/**
 * Reason this URL must be blocked outright (never prompted), or null if allowed.
 * Rejects non-http(s) schemes (file/ftp/...) and literal-IP SSRF targets. Also
 * used by the permission gate so a blocked request is refused before any
 * prompt. This is a synchronous, DNS-free check — see resolvedHostBlockReason
 * for the check that also catches a hostname that merely *resolves* to a
 * blocked address, which this function cannot see.
 */
export function httpBlockReason(args: { url?: unknown }): string | null {
  const raw = String(args?.url ?? "");
  if (!raw) return "http: a url is required.";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `http: invalid URL: ${raw}`;
  }
  const scheme = u.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") {
    return `http: blocked scheme "${u.protocol}" — only http and https are allowed (no file://, ftp://, ...).`;
  }
  if (isBlockedHost(u.hostname)) {
    return `http: blocked host ${u.hostname} — loopback, private, or cloud-metadata addresses are refused (SSRF guard).`;
  }
  return null;
}

/**
 * DNS-aware companion to httpBlockReason: resolves a non-literal hostname and
 * checks EVERY returned address against the same blocklist, refusing the
 * whole request if any of them lands inside it. Without this, a domain name
 * (as opposed to an IP literal) sailed through the guard entirely — nothing
 * upstream of fetch() ever inspected what it actually resolves to. A literal
 * IP hostname is skipped here (already fully covered by isBlockedHost).
 *
 * This still leaves a narrow, acknowledged residual race: fetch()'s own DNS
 * resolution happens moments after this check, so a resolver that returns a
 * different, blocked answer on the *next* lookup (true DNS rebinding, which
 * requires an attacker-controlled authoritative server and a very low TTL)
 * is not fully pinned out. That is a materially harder attack than the
 * "domain just resolves to an internal IP" case this closes, and matches
 * common practice for this class of guard.
 */
// Swappable so offline verify suites can mock fetch() without needing real
// DNS to resolve their test hostnames (api.example.com and friends don't have
// A/AAAA records) — production always uses the real resolver.
let dnsLookupImpl: typeof realDnsLookup = realDnsLookup;
/** Test-only: override the resolver resolvedHostBlockReason uses. Pass null
 * to restore the real one. */
export function setDnsLookupForTests(fn: typeof realDnsLookup | null): void {
  dnsLookupImpl = fn ?? realDnsLookup;
}

async function resolvedHostBlockReason(hostname: string): Promise<string | null> {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || net.isIP(h)) return null; // literal IPs are handled by isBlockedHost already
  let records: { address: string }[];
  try {
    records = await dnsLookupImpl(h, { all: true, verbatim: true });
  } catch (e) {
    return `http: could not resolve host ${h}: ${(e as Error).message}`;
  }
  for (const r of records) {
    if (isBlockedHost(r.address)) {
      return `http: blocked host ${h} — resolves to ${r.address}, a loopback, private, or cloud-metadata address (SSRF guard).`;
    }
  }
  return null;
}

// --- secret substitution ----------------------------------------------------

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function substitute(str: string, env: Record<string, string>, missing: Set<string>): string {
  return str.replace(VAR_RE, (_, name: string) => {
    if (Object.prototype.hasOwnProperty.call(env, name)) return env[name]!;
    missing.add(name);
    return "";
  });
}

// --- output formatting (redaction-safe) -------------------------------------

function redactValue(name: string, value: string): string {
  return SENSITIVE_HEADERS.has(name.toLowerCase()) ? "<redacted>" : value;
}

/** Echo the request the model asked for, using ORIGINAL (pre-substitution) values
 * so a ${VAR} is shown verbatim and a substituted secret can never appear; names
 * that carry credentials are additionally forced to <redacted>. */
function echoRequest(method: string, rawUrl: string, headers: Record<string, string>): string {
  const lines = [`${method} ${rawUrl}`];
  for (const [k, v] of Object.entries(headers)) lines.push(`> ${k}: ${redactValue(k, v)}`);
  return lines.join("\n");
}

function formatResponseHeaders(h: Headers): string {
  const lines: string[] = [];
  for (const [k, v] of h.entries()) lines.push(`< ${k}: ${redactValue(k, v)}`);
  return lines.join("\n");
}

function prettyBody(raw: string, contentType: string | null): string {
  const ct = (contentType ?? "").toLowerCase();
  const looksJson = ct.includes("json") || /^\s*[[{]/.test(raw);
  if (looksJson) {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      /* not actually JSON — fall through */
    }
  }
  return raw;
}

function composeSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof (AbortSignal as any).any === "function") return (AbortSignal as any).any([signal, timeout]);
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  timeout.addEventListener("abort", onAbort, { once: true });
  return ac.signal;
}

// --- the tool ---------------------------------------------------------------

export async function runHttp(args: HttpArgs, signal?: AbortSignal): Promise<ToolResult> {
  let method = normalizeMethod(args.method);

  // Guard the URL the model gave us (before substitution — hosts are normally literal).
  const rawBlock = httpBlockReason(args);
  if (rawBlock) return { output: rawBlock, isError: true };

  // Substitute ${VAR} secrets from ~/.dom/.env into url, header values, and body.
  const env = await loadEnv();
  const missing = new Set<string>();
  const url = substitute(String(args.url), env, missing);
  const sentHeaders: Record<string, string> = {};
  const rawHeaders = args.headers ?? {};
  for (const [k, v] of Object.entries(rawHeaders)) sentHeaders[k] = substitute(v, env, missing);
  const body = args.body != null ? substitute(args.body, env, missing) : undefined;
  if (missing.size) {
    const names = [...missing].join(", ");
    const plural = missing.size > 1;
    return {
      output: `http: missing key${plural ? "s" : ""} ${names} — add ${plural ? "them" : "it"} to ${envPath()} as ${
        plural ? "NAME=value lines" : "NAME=value"
      }.`,
      isError: true,
    };
  }

  // Re-guard the substituted URL, in case a ${VAR} expanded into the host.
  const subBlock = httpBlockReason({ url });
  if (subBlock) return { output: subBlock, isError: true };

  const timeoutS = args.timeout ?? DEFAULT_TIMEOUT_S;
  const reqSignal = composeSignal(signal, timeoutS * 1000);
  const hasBody = !SAFE_METHODS.has(method) && body != null;

  // Follow redirects manually so we can cap at MAX_REDIRECTS and re-run the SSRF
  // guard on every hop — a 302 to 169.254.169.254 must not slip past.
  let currentUrl = url;
  let response: Response;
  try {
    for (let hop = 0; ; hop++) {
      const hopBlock = httpBlockReason({ url: currentUrl });
      if (hopBlock) return { output: `${hopBlock} (redirect target)`, isError: true };
      const dnsBlock = await resolvedHostBlockReason(new URL(currentUrl).hostname);
      if (dnsBlock) return { output: `${dnsBlock}${hop > 0 ? " (redirect target)" : ""}`, isError: true };
      response = await fetch(currentUrl, {
        method,
        headers: sentHeaders,
        body: hasBody ? body : undefined,
        redirect: "manual",
        signal: reqSignal,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const loc = response.headers.get("location");
      if (!loc) break; // a 3xx without Location — treat as the final response
      if (hop >= MAX_REDIRECTS) {
        return { output: `http: too many redirects (>${MAX_REDIRECTS}) starting at ${url}`, isError: true };
      }
      currentUrl = new URL(loc, currentUrl).toString();
      // 303 (and, by common convention, 301/302 after a POST) switch to GET.
      if (response.status === 303) {
        method = "GET";
      }
    }
  } catch (e) {
    if (signal?.aborted) return { output: "■ aborted", isError: true, aborted: true };
    if ((e as Error).name === "TimeoutError") {
      return { output: `http: request timed out after ${timeoutS}s`, isError: true };
    }
    return { output: `http: ${(e as Error).message}`, isError: true };
  }

  let rawText: string;
  try {
    rawText = await response.text();
  } catch (e) {
    if (signal?.aborted) return { output: "■ aborted", isError: true, aborted: true };
    return { output: `http: failed reading response body: ${(e as Error).message}`, isError: true };
  }

  const bodyOut = prettyBody(rawText, response.headers.get("content-type"));
  const sections = [
    echoRequest(normalizeMethod(args.method), String(args.url), rawHeaders),
    "",
    `${response.status} ${response.statusText}`.trim(),
    formatResponseHeaders(response.headers),
    "",
    bodyOut,
  ];
  return { output: truncateOutput(sections.join("\n")), isError: response.status >= 400 };
}

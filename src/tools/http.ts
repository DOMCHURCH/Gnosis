// The http tool: make an outbound HTTP(S) request. Guarded against SSRF (no
// loopback/private/metadata hosts, http/https only), substitutes ${VAR} secrets
// from ~/.dom/.env at request time WITHOUT ever letting a key reach message
// history or the transcript (Authorization/api-key are shown as <redacted>, and
// the echoed request uses the model's original ${VAR} text, never the value).

import { promises as fs } from "node:fs";
import path from "node:path";
import { domDir } from "../config.js";
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

export function envPath(): string {
  return path.join(domDir(), ".env");
}

// --- SSRF / scheme guard ----------------------------------------------------

/** Is this hostname a loopback / private / link-local / cloud-metadata target? */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::" || h === "::1") return true; // IPv6 unspecified / loopback
  if (/^fe80:/i.test(h)) return true; // IPv6 link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true; // IPv6 unique-local fc00::/7

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 127) return true; // loopback 127.0.0.0/8
    if (a === 10) return true; // private 10.0.0.0/8
    if (a === 192 && b === 168) return true; // private 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
    return false;
  }

  // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
  const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) return isBlockedHost(mapped[1]!);
  return false;
}

/**
 * Reason this URL must be blocked outright (never prompted), or null if allowed.
 * Rejects non-http(s) schemes (file/ftp/...) and SSRF targets. Also used by the
 * permission gate so a blocked request is refused before any prompt.
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

// --- secret substitution ----------------------------------------------------

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Parse ~/.dom/.env (KEY=value lines, # comments, optional quotes). */
export async function loadEnv(): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  let txt: string;
  try {
    txt = await fs.readFile(envPath(), "utf8");
  } catch {
    return env; // absent — every ${VAR} will be reported missing
  }
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k) env[k] = v;
  }
  return env;
}

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

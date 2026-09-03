// `dom serve`: a LAN-reachable HTTP + WebSocket server that mirrors the running
// engines to a browser. It is a VIEW/remote-control over the same engines the Ink
// TUI drives — never a second agent.
//
// "LAN-reachable", not "localhost-only", which is what this line used to say: it
// binds 0.0.0.0 (see bindHost below) so a phone on the same WiFi can open the
// UI. The token is the access control, not the bind address — and a comment
// that understates the reach of a server is the kind of wrong that stops
// someone asking the right question about it.
//
// Every event on the bus is forwarded to connected clients; client messages
// route back through the AppBridge.
//
// Security (all enforced here, before anything else runs):
//   - binds 0.0.0.0 so a phone on the same WiFi can reach it (LAN is always on)
//   - rejects any request whose Host header isn't loopback or a private LAN IPv4
//     (DNS-rebinding defense — a public hostname is still refused)
//   - a random per-startup token is required on every HTTP request and WS connect,
//     so reachability alone grants nothing: without the token there is no access
//
// The WebSocket layer is hand-rolled (RFC 6455 text frames) so dom stays
// dependency-light — the browser uses the native WebSocket API on the other end.

import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { promises as fs, promises as fsp } from "node:fs";
import path from "node:path";

/** Ceiling for /api/file/raw. Large enough for charts and PDFs, small enough that
 *  a stray binary can't pin the process buffering it. */
const MAX_RAW_BYTES = 12 * 1024 * 1024;
import { WEB_ASSETS_DIR } from "./install.js";
import { buildTree, readFileInRoot, resolveInRoot, RAW_MIME } from "./filetree.js";
import { buildIgnorer } from "./tools/ignore.js";
import { buildVaultTree, vaultRoot } from "./vault.js";
import { jobs, bridgeJobsToBus } from "./jobs.js";
import { spawnPty, killAllPtys } from "./pty.js";
import type { AppBridge, DomEvent } from "./events.js";
import type { PermissionAnswer } from "./permissions.js";
import { mcp } from "./mcp/manager.js";
import { panelSummary, clearSessionMemory } from "./sessionmemory.js";
import { webhooks } from "./webhooks.js";
import { lanIp, isPrivateIpv4 } from "./netip.js";
import { loadEnv, loadConfig } from "./config.js";
import { isScreenshotName } from "./screenshots.js";
import { screenshotsDir, gnosisDir } from "./workspace.js";

/** Read a request body to a string, capped at maxBytes (excess is drained, not stored). */
function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(Buffer.concat(chunks).toString("utf8")); };
    req.on("data", (c: Buffer) => { size += c.length; if (size <= maxBytes) chunks.push(c); });
    req.on("end", finish);
    req.on("error", finish);
  });
}

/** Flatten node's header bag to a plain string→string map (arrays joined). */
function flatHeaders(h: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
  return out;
}

// Keys the CONNECTIONS tab knows about, with the feature each one enables. Others
// present in ~/.dom/.env are also surfaced (name + last 4 only).
const KNOWN_KEYS = [
  { name: "OPENROUTER_API_KEY", feature: "model calls (required)" },
  { name: "BRAVE_API_KEY", feature: "web_search tool" },
  { name: "CONTEXT7_API_KEY", feature: "Context7 MCP (higher rate limits)" },
];

/** Presence + last-4 of the keys that matter, never the full value. */
async function collectKeys(): Promise<{ name: string; present: boolean; last4: string | null; feature: string }[]> {
  const env = await loadEnv();
  const cfg = await loadConfig();
  const seen = new Set<string>();
  const out: { name: string; present: boolean; last4: string | null; feature: string }[] = [];
  for (const k of KNOWN_KEYS) {
    const val = env[k.name] ?? process.env[k.name];
    out.push({ name: k.name, present: !!val, last4: val ? String(val).slice(-4) : null, feature: k.feature });
    seen.add(k.name);
  }
  out.push({ name: "groqApiKey", present: !!cfg.groqApiKey, last4: cfg.groqApiKey ? cfg.groqApiKey.slice(-4) : null, feature: "Groq models (config.json)" });
  seen.add("groqApiKey");
  for (const [k, v] of Object.entries(env)) {
    if (seen.has(k) || !/key|token|secret/i.test(k)) continue;
    out.push({ name: k, present: true, last4: v.slice(-4), feature: "" });
  }
  return out;
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Host-header allowlist: loopback names, plus private LAN IPv4s (always — a phone
 * on the same WiFi reaches the UI by IP). Any other Host is refused, so DNS
 * rebinding through a public hostname is still blocked. The token gate is the
 * access control; this is only the rebinding defense. */
export function hostOk(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, "").toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return true;
  return isPrivateIpv4(host);
}

function tokenOk(candidate: string | undefined | null, token: string): boolean {
  const a = Buffer.from(String(candidate ?? ""));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** WebSocket upgrade defense-in-depth: hostOk/tokenOk are the real gate, but
 * neither checks Origin. A browser always sends one; a non-browser client
 * (curl, a Node script driving the API directly — a documented, supported
 * way to reach dom serve) never does, so absence is not itself suspicious.
 * When present, it must name the same loopback/private-LAN host hostOk
 * already trusts — this is what would still block a malicious webpage from
 * opening a cross-site WebSocket if the token ever leaked by some other
 * means, since Origin (unlike a query param) cannot be forged by the page
 * making the request. */
function originOk(originHeader: string | undefined): boolean {
  if (!originHeader) return true;
  try {
    return hostOk(new URL(originHeader).host);
  } catch {
    return false;
  }
}

// --- WebSocket framing -------------------------------------------------------

function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}
const encodeText = (s: string): Buffer => frame(0x1, Buffer.from(s, "utf8"));

/** Stateful decoder for masked client frames. Small JSON messages arrive as single
 * text frames; continuation (0x0) is treated as a message boundary too. */
function makeDecoder(onText: (s: string) => void, onClose: () => void, onPing: (p: Buffer) => void): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0]! & 0x0f;
      const masked = (buf[1]! & 0x80) !== 0;
      let len = buf[1]! & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      let mask: Buffer | null = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        mask = buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buf.length < offset + len) return; // wait for the full payload
      let payload = buf.subarray(offset, offset + len);
      if (mask) {
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i]! ^ mask[i % 4]!;
        payload = out;
      }
      buf = buf.subarray(offset + len);
      if (opcode === 0x8) return onClose();
      if (opcode === 0x9) onPing(payload);
      else if (opcode === 0x1 || opcode === 0x0) onText(payload.toString("utf8"));
      // 0xA (pong) / 0x2 (binary) ignored
    }
  };
}

// --- static frontend ---------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

const PLACEHOLDER_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>dom</title>
<style>body{background:#0D0D12;color:#c9d1d9;font:14px ui-monospace,monospace;margin:2rem}
a{color:#22D3EE}.k{color:#E879F9}</style></head><body>
<h1>dom <span class="k">serve</span></h1>
<p>The server and event stream are live. The browser UI ships in phase 2.</p>
<pre id="log">connecting…</pre>
<script>
const t=new URLSearchParams(location.search).get('token');
const ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws?token='+encodeURIComponent(t));
const log=document.getElementById('log');
ws.onopen=()=>log.textContent='connected — waiting for events…\\n';
ws.onmessage=e=>{log.textContent+=e.data+'\\n';};
ws.onclose=()=>log.textContent+='[disconnected]\\n';
</script></body></html>`;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": MIME[".json"]! });
  res.end(JSON.stringify(body));
}

/** Resolve the cwd of a given tab from the live agent snapshot, or null. */
/**
 * Which directory a browse request is rooted at: the session's cwd by default, or
 * the ~/Gnosis workspace when the client asks for `root=gnosis`.
 *
 * The traversal guards downstream (resolveInRoot / readFileInRoot) are unchanged
 * and still confine every path to whichever root this returns — swapping the root
 * does not widen them, it only chooses which one applies. ~/Gnosis is created on
 * demand so a fresh install browses an empty folder rather than a 404.
 */
async function rootForRequest(bridge: AppBridge, url: URL): Promise<string | null> {
  if (url.searchParams.get("root") === "gnosis") {
    const dir = gnosisDir();
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    return dir;
  }
  return cwdForTab(bridge, Number(url.searchParams.get("tabId")));
}

function cwdForTab(bridge: AppBridge, tabId: number): string | null {
  const a = bridge.getAgents().find((x) => x.id === tabId);
  return a ? a.cwd : null;
}

/**
 * Token-gated File Browser API (the human's read-only window into a session's cwd):
 *   GET /api/tree?tabId=N        → { cwd, tree, truncated }
 *   GET /api/file?tabId=N&path=R → { path, content, truncated }
 * The cwd comes from the live agent, and file reads are guarded to stay inside it
 * (readFileInRoot). Returns true if it handled the request.
 */
async function handleApi(req: http.IncomingMessage, url: URL, bridge: AppBridge, res: http.ServerResponse, getPublicUrl: () => string | null, getLanUrl: () => string | null, webhookToken: string): Promise<boolean> {
  // Serve info: the public tunnel URL (if `/serve --public` is up), so the WEBHOOKS
  // tab can show the URL external services actually need to reach.
  if (url.pathname === "/api/serveinfo") {
    sendJson(res, 200, { public: getPublicUrl(), lan: getLanUrl() });
    return true;
  }
  // Webhook inspector: the whole ring buffer, plus the public URL and the
  // separate low-privilege token the generator needs to build a working URL
  // (this route itself is gated on the master token, same as every /api/*
  // route — only /webhook/* itself uses webhookToken).
  if (url.pathname === "/api/webhooks") {
    sendJson(res, 200, { webhooks: webhooks.list(), labels: webhooks.labels(), public: getPublicUrl(), webhookToken });
    return true;
  }
  // Replay a stored webhook to a local target URL (POST { target }).
  const replay = url.pathname.match(/^\/api\/webhooks\/([^/]+)\/replay$/);
  if (replay) {
    const entry = webhooks.get(replay[1]!);
    if (!entry) { sendJson(res, 404, { error: "unknown webhook" }); return true; }
    let target = "";
    try { target = String(JSON.parse(await readBody(req, 8192)).target ?? ""); } catch { /* no/invalid body */ }
    if (!/^https?:\/\//i.test(target)) { sendJson(res, 400, { error: "provide a target http(s) URL" }); return true; }
    try {
      const r = await fetch(target, { method: entry.method, headers: entry.contentType ? { "content-type": entry.contentType } : {}, body: entry.method === "GET" || entry.method === "HEAD" ? undefined : entry.body });
      sendJson(res, 200, { ok: r.ok, status: r.status });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: (e as Error).message });
    }
    return true;
  }
  if (url.pathname === "/api/tree") {
    const root = await rootForRequest(bridge, url);
    if (root == null) { sendJson(res, 404, { error: "unknown tab" }); return true; }
    // Hide temp/noise files (.gitignore/.domignore + auto-excludes) from the browser.
    sendJson(res, 200, await buildTree(root, { ignore: buildIgnorer(root, false) }));
    return true;
  }
  if (url.pathname === "/api/file") {
    const rel = url.searchParams.get("path") ?? "";
    const cwd = await rootForRequest(bridge, url);
    if (cwd == null) { sendJson(res, 404, { error: "unknown tab" }); return true; }
    const preview = await readFileInRoot(cwd, rel);
    if (!preview) { sendJson(res, 404, { error: "not found" }); return true; }
    sendJson(res, 200, preview);
    return true;
  }
  // Raw file bytes for the chat rail's rich output (inline images, PDF cards).
  // Same token gate and same traversal guard as the file browser; the only
  // difference is that this one answers with bytes instead of a utf8 preview.
  if (url.pathname === "/api/file/raw") {
    const rel = url.searchParams.get("path") ?? "";
    const cwd = await rootForRequest(bridge, url);
    if (cwd == null) { sendJson(res, 404, { error: "unknown tab" }); return true; }
    const full = resolveInRoot(cwd, rel);
    if (!full) { sendJson(res, 403, { error: "outside the session root" }); return true; }
    try {
      const stat = await fsp.stat(full);
      if (!stat.isFile()) { sendJson(res, 404, { error: "not a file" }); return true; }
      if (stat.size > MAX_RAW_BYTES) { sendJson(res, 413, { error: "file too large to preview" }); return true; }
      const ext = path.extname(full).toLowerCase();
      const mime = RAW_MIME[ext] ?? "application/octet-stream";
      const body = await fsp.readFile(full);
      // SVG is the one inline-rendered type that can carry a <script> — every
      // other unrecognised type already forces a download below. Rendered
      // inline (not through an <img>, which never executes SVG script — via a
      // direct tab/iframe open of this URL), a malicious SVG anywhere in the
      // workspace (a repo file, or one a prompt-injected agent wrote) runs
      // script in the server's own origin, with the page's own ?token= sitting
      // right there in location.search for it to read. Force it through the
      // same download path as an unknown type, plus a locked-down CSP as a
      // second layer in case a future caller ever renders it inline anyway.
      const forceDownload = mime === "application/octet-stream" || ext === ".svg";
      res.writeHead(200, {
        "content-type": mime,
        "content-length": String(body.length),
        ...(forceDownload ? { "content-disposition": `attachment; filename="${path.basename(full).replace(/"/g, "")}"` } : {}),
        ...(ext === ".svg" ? { "content-security-policy": "default-src 'none'; sandbox" } : {}),
        // The bytes are the user's own files behind a token — never let a shared
        // cache hold them.
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(body);
    } catch {
      sendJson(res, 404, { error: "not found" });
    }
    return true;
  }
  // Images tools handed back (MCP screenshots), which live in ~/Gnosis/screenshots —
  // outside every session root, so /api/file/raw correctly refuses them. This
  // serves that ONE directory, by basename only: no tabId, no relative path, and
  // nothing that could walk out of it. Same token gate as everything else.
  if (url.pathname === "/api/screenshot") {
    const name = url.searchParams.get("name") ?? "";
    if (!isScreenshotName(name)) { sendJson(res, 400, { error: "bad name" }); return true; }
    const full = path.join(screenshotsDir(), name);
    try {
      const stat = await fsp.stat(full);
      if (!stat.isFile()) { sendJson(res, 404, { error: "not a file" }); return true; }
      if (stat.size > MAX_RAW_BYTES) { sendJson(res, 413, { error: "too large" }); return true; }
      const body = await fsp.readFile(full);
      res.writeHead(200, {
        "content-type": RAW_MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream",
        "content-length": String(body.length),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(body);
    } catch {
      sendJson(res, 404, { error: "not found" });
    }
    return true;
  }

  // Background jobs: the whole live list (pid/port/status/runtime source), and one
  // job's captured output for the "view output" modal. Kill is a WS action, not a
  // GET, so it can't be triggered by a stray navigation.
  if (url.pathname === "/api/jobs") {
    sendJson(res, 200, { jobs: jobs.list() });
    return true;
  }
  if (url.pathname === "/api/job") {
    const id = url.searchParams.get("id") ?? "";
    const output = jobs.output(id);
    if (output == null) { sendJson(res, 404, { error: "unknown job" }); return true; }
    sendJson(res, 200, { id, output });
    return true;
  }
  // Obsidian vault: the .md-only note tree (with a `configured` flag so the panel
  // tab can hide itself), and one note's raw markdown for the reader/renderer.
  if (url.pathname === "/api/vault/tree") {
    sendJson(res, 200, await buildVaultTree());
    return true;
  }
  if (url.pathname === "/api/vault/note") {
    const rel = url.searchParams.get("path") ?? "";
    const root = await vaultRoot();
    if (root == null) { sendJson(res, 404, { error: "no vault" }); return true; }
    const preview = await readFileInRoot(root, rel);
    if (!preview) { sendJson(res, 404, { error: "not found" }); return true; }
    sendJson(res, 200, preview);
    return true;
  }
  // CONNECTIONS tab: MCP servers + status/tools, API-key presence, loaded skills,
  // and background jobs bound to a port (the HTTP section).
  if (url.pathname === "/api/connections") {
    sendJson(res, 200, {
      mcp: mcp.connections(),
      keys: await collectKeys(),
      skills: bridge.getSkills ? bridge.getSkills() : [],
      jobs: jobs.list().filter((j) => j.port != null),
    });
    return true;
  }
  // MEMORY panel (CONNECTIONS tab): automatic learned-context summary.
  if (url.pathname === "/api/memory") {
    sendJson(res, 200, await panelSummary());
    return true;
  }
  return false;
}

const gzip = promisify(zlib.gzip);

/** Types worth compressing. Images and octet-streams are already compressed;
 *  running them through zlib costs CPU and returns nothing. */
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg", ".map"]);

/**
 * Send a static body, gzipped when the client asked for it.
 *
 * This matters more here than on a typical server. The frontend is inlined into
 * a SINGLE file by viteSingleFile — one ~1.6MB index.html, three.js and all —
 * and the whole reason this binds the LAN is so a phone on the same WiFi can
 * load it. Uncompressed, that full 1.6MB is the cost of opening the UI on a
 * phone, paid on every cold load over WiFi. It gzips to roughly a quarter.
 *
 * Never when the client did not offer to accept it, and never for bodies too
 * small to be worth the round trip through zlib.
 */
async function sendMaybeGzipped(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer,
  contentType: string,
  ext: string,
): Promise<void> {
  const accepts = String(req.headers["accept-encoding"] ?? "").toLowerCase().includes("gzip");
  if (!accepts || !COMPRESSIBLE.has(ext) || body.length < 1024) {
    res.writeHead(200, { "content-type": contentType });
    res.end(body);
    return;
  }
  try {
    const packed = await gzip(body);
    res.writeHead(200, {
      "content-type": contentType,
      "content-encoding": "gzip",
      // Caches and proxies must not hand a gzipped body to a client that never
      // asked for one.
      vary: "Accept-Encoding",
    });
    res.end(packed);
  } catch {
    // Compression is an optimisation; failing at it must not fail the response.
    res.writeHead(200, { "content-type": contentType });
    res.end(body);
  }
}

async function serveStatic(req: http.IncomingMessage, pathname: string, staticDir: string, res: http.ServerResponse): Promise<void> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const full = path.join(staticDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  // Path-traversal guard: the resolved file must stay inside staticDir.
  if (!full.startsWith(path.resolve(staticDir))) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  const ext = path.extname(full);
  try {
    const body = await fs.readFile(full);
    await sendMaybeGzipped(req, res, body, MIME[ext] ?? "application/octet-stream", ext);
  } catch {
    if (rel === "/index.html") {
      // no built frontend yet → placeholder
      await sendMaybeGzipped(req, res, Buffer.from(PLACEHOLDER_HTML), MIME[".html"]!, ".html");
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  }
}

function handleClientMessage(bridge: AppBridge, text: string, send: (w: unknown) => void): void {
  let msg: any;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  switch (msg?.type) {
    case "input": {
      // Optional file attachments: [{ name, mime, data (base64) }]. Coerced to
      // strings defensively; the engine gates each on the model's modalities.
      const attachments = Array.isArray(msg.attachments)
        ? msg.attachments
            .filter((a: unknown) => a && typeof a === "object")
            .map((a: any) => ({ name: String(a.name ?? "file"), mime: String(a.mime ?? "application/octet-stream"), data: String(a.data ?? "") }))
            .filter((a: { data: string }) => a.data.length > 0)
        : undefined;
      bridge.onInput?.(Number(msg.tabId), String(msg.text ?? ""), attachments);
      break;
    }
    case "command":
      bridge.onCommand?.(Number(msg.tabId), String(msg.command ?? ""));
      break;
    case "files":
      void Promise.resolve(bridge.onFiles ? bridge.onFiles(Number(msg.tabId), String(msg.query ?? "")) : [])
        .then((list) => send({ type: "files", reqId: msg.reqId, list }))
        .catch(() => send({ type: "files", reqId: msg.reqId, list: [] }));
      break;
    case "permission":
      bridge.answerPermission(String(msg.id ?? ""), String(msg.answer ?? "no") as PermissionAnswer);
      break;
    case "agent.background":
      bridge.onBackgroundAgent?.(Number(msg.tabId), String(msg.text ?? ""));
      break;
    case "ask.answer":
      bridge.answerAsk(String(msg.id ?? ""), String(msg.answer ?? ""));
      break;
    case "overlay.select":
      bridge.answerOverlay(String(msg.id ?? ""), String(msg.value ?? ""));
      break;
    case "overlay.cancel":
      bridge.answerOverlay(String(msg.id ?? ""), null);
      break;
    case "mcp.toggle":
      // Enable/disable an MCP server for this session, then tell every client to
      // re-fetch the CONNECTIONS data (status + tool counts change).
      void mcp
        .setEnabled(String(msg.name ?? ""), Boolean(msg.enabled))
        .then(() => bridge.bus.emit({ type: "connections.changed" }))
        .catch(() => {});
      break;
    case "memory.clear":
      // Wipe the automatic learned context, then tell clients to re-fetch.
      void clearSessionMemory()
        .then(() => bridge.bus.emit({ type: "connections.changed" }))
        .catch(() => {});
      break;
    case "agent.create":
      bridge.onCreateAgent?.(msg.name, msg.purpose);
      break;
    case "agent.close":
      bridge.onCloseAgent?.(Number(msg.tabId));
      break;
    case "agent.stop":
      bridge.onStopAgent?.(Number(msg.tabId));
      break;
    case "goal.set":
      bridge.onGoalSet?.(Number(msg.tabId), {
        text: String(msg.text ?? ""),
        maxRounds: msg.maxRounds != null ? Number(msg.maxRounds) : undefined,
        reviewModel: msg.reviewModel ? String(msg.reviewModel) : undefined,
        active: msg.active != null ? Boolean(msg.active) : undefined,
      });
      break;
    case "goal.clear":
      bridge.onGoalClear?.(Number(msg.tabId));
      break;
    case "job.kill":
      // SIGTERM the whole tree, escalating to SIGKILL (killTree's own behavior).
      // The resulting job.end flows back through the bus like any other event.
      jobs.kill(String(msg.jobId ?? ""));
      break;
    case "vault.save": {
      // Save the given content as a new vault note; ack the requesting client with
      // the written path (or an error). onVaultSave emits vault.changed on success,
      // which refreshes every client's Obsidian panel.
      const reqId = msg.reqId;
      const tags = Array.isArray(msg.tags) ? msg.tags.map((t: unknown) => String(t)) : [];
      const done = (r: { ok: boolean; path?: string; error?: string }) => send({ type: "vault.saved", reqId, ...r });
      if (!bridge.onVaultSave) { done({ ok: false, error: "vault save unavailable" }); break; }
      void bridge
        .onVaultSave(String(msg.filename ?? ""), tags, String(msg.content ?? ""), msg.folder ? String(msg.folder) : undefined)
        .then(done)
        .catch((e) => done({ ok: false, error: (e as Error)?.message ?? "save failed" }));
      break;
    }
  }
}

/**
 * Bridge an already-upgraded websocket to a real pseudo-terminal in `cwd`. Terminal
 * bytes stream out as text frames; the client sends JSON control messages:
 *   { "d": "<keystrokes>" }          — write to the pty (Ctrl+C is just 0x03 here)
 *   { "r": { "cols": N, "rows": M } } — resize the pty
 * Purely a human channel: nothing here is emitted on the event bus or seen by the
 * model. The pty (and this socket) die with the server or when either side closes.
 */
function attachPty(socket: Duplex, cwd: string, cols: number, rows: number): void {
  let closed = false;
  const close = () => { if (closed) return; closed = true; try { socket.destroy(); } catch { /* gone */ } };
  void spawnPty(cwd, cols, rows)
    .then((pty) => {
      if (closed) return void pty.kill();
      pty.onData((d) => { try { socket.write(encodeText(d)); } catch { /* gone */ } });
      pty.onExit(() => { try { socket.write(encodeText("\r\n[process exited]\r\n")); } catch { /* gone */ } close(); });
      const decode = makeDecoder(
        (text) => {
          let msg: any;
          try { msg = JSON.parse(text); } catch { return; }
          if (typeof msg?.d === "string") pty.write(msg.d);
          else if (msg?.r && typeof msg.r.cols === "number") pty.resize(msg.r.cols, msg.r.rows);
        },
        () => { pty.kill(); close(); },
        (p) => { try { socket.write(frame(0xa, p)); } catch { /* ignore */ } },
      );
      socket.on("data", (c: Buffer) => { try { decode(c); } catch { pty.kill(); close(); } });
      socket.on("close", () => { pty.kill(); close(); });
      socket.on("error", () => { pty.kill(); close(); });
    })
    .catch(() => {
      // node-pty unavailable (native binary missing) → tell the user, then close.
      try { socket.write(encodeText("\r\n[terminal unavailable: node-pty failed to load]\r\n")); } catch { /* ignore */ }
      close();
    });
}

export interface ServerHandle {
  url: string;
  token: string;
  /** Separate, lower-privilege token that gates ONLY /webhook/*. A webhook URL
   * is handed to third-party services (GitHub, Stripe, ...) which routinely
   * show full delivery URLs — including the query string — to anyone with
   * admin on that integration. `token` is equivalent to a full interactive
   * shell (via /pty); that must never be the secret that ends up in someone
   * else's delivery log. */
  webhookToken: string;
  port: number;
  clients(): number;
  /** The LAN URL (base, no token); null only when the machine has no LAN address. */
  lanUrl: string | null;
  /** Record the public tunnel URL (base, no token) so /api/serveinfo exposes it. */
  setPublicUrl(url: string | null): void;
  close(): Promise<void>;
}

/** Signals that mean "the user is stopping the server" (SIGBREAK is Windows Ctrl+Break),
 * with the number each one contributes to the conventional 128+n exit code. */
const SIGNAL_NUMBERS = { SIGINT: 2, SIGTERM: 15, SIGBREAK: 21 } as const;
const SHUTDOWN_SIGNALS = Object.keys(SIGNAL_NUMBERS) as (keyof typeof SIGNAL_NUMBERS)[];

export async function startServer(bridge: AppBridge, opts: { port?: number } = {}): Promise<ServerHandle> {
  const token = crypto.randomBytes(24).toString("base64url");
  const webhookToken = crypto.randomBytes(24).toString("base64url");
  // Identity of THIS server instance, announced to every client as it connects. A
  // browser that reconnects and sees a different instance knows its whole picture
  // belongs to a server that no longer exists, and starts over. `instance` is what
  // the comparison uses — two servers really can start within the same millisecond,
  // and an identity check that is only probably unique is not an identity check.
  const startedAt = Date.now();
  const instance = crypto.randomBytes(12).toString("base64url");
  // The public tunnel URL (base, no token), set by /serve --public via setPublicUrl.
  let publicUrl: string | null = null;
  // LAN is always on: bind every interface and accept private-LAN Hosts so a phone
  // on the same WiFi can scan the QR and land straight in the UI. There is no flag
  // to turn this on or off — the per-startup token is what gates access.
  const bindHost = "0.0.0.0";
  const lanAddr = lanIp();
  // Resolved from the binary's own location (not the cwd) so assets are found no
  // matter where `dom serve` was launched.
  const staticDir = WEB_ASSETS_DIR;

  // Broadcast + reconnect ring buffer. Every bus event is tagged with a monotonic
  // seq and kept (last RING) so a client that drops can replay what it missed via
  // ?since=<lastSeq>. One bus subscription fans out to all connected clients.
  const clients = new Set<{ send: (w: unknown) => void; socket: Duplex }>();
  const ring: Array<Record<string, unknown> & { seq: number }> = [];
  const RING = 2000;
  let seq = 0;
  const busUnsub = bridge.bus.subscribe((e) => {
    const w = { ...e, seq: ++seq };
    ring.push(w);
    if (ring.length > RING) ring.shift();
    for (const c of clients) c.send(w);
  });
  // Forward background-job lifecycle (start/end) onto the same bus so browsers see
  // jobs appear and finish. Torn down with the server (close()).
  const jobsUnsub = bridgeJobsToBus(bridge.bus);

  const server = http.createServer((req, res) => {
    // Every response gets this — set before any writeHead so it survives every
    // response path below (Node merges setHeader into a later writeHead's own
    // headers object). Printed URLs carry the token in ?token=, so the token
    // is effectively a credential in the address bar; without this, any
    // outbound navigation/resource load FROM the served UI leaks it to a
    // third party via the Referer header.
    res.setHeader("referrer-policy", "no-referrer");
    if (!hostOk(req.headers.host)) {
      res.writeHead(403);
      res.end("forbidden host");
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    // Webhook capture: any method to /webhook/:label is stored in the ring
    // buffer and announced on the bus. Gated on webhookToken, NOT the master
    // token — see ServerHandle.webhookToken for why the two must not be the
    // same secret.
    if (url.pathname.startsWith("/webhook/")) {
      const whTok = url.searchParams.get("token") ?? (req.headers["x-dom-token"] as string | undefined);
      if (!tokenOk(whTok, webhookToken)) {
        res.writeHead(401);
        res.end("unauthorized");
        return;
      }
      void (async () => {
        const label = decodeURIComponent(url.pathname.slice("/webhook/".length)).replace(/\/+$/, "") || "default";
        const body = await readBody(req, 256 * 1024);
        const entry = webhooks.record({ label, method: req.method ?? "POST", contentType: String(req.headers["content-type"] ?? ""), headers: flatHeaders(req.headers), body, statusReturned: 200 });
        bridge.bus.emit({ type: "webhook.received", id: entry.id, label: entry.label, method: entry.method, size: entry.size });
        sendJson(res, 200, { ok: true, id: entry.id, label: entry.label });
      })().catch(() => { res.writeHead(500); res.end("error"); });
      return;
    }

    const tok = url.searchParams.get("token") ?? (req.headers["x-dom-token"] as string | undefined);
    if (!tokenOk(tok, token)) {
      res.writeHead(401);
      res.end("unauthorized");
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      void handleApi(req, url, bridge, res, () => publicUrl, () => (lanAddr ? `http://${lanAddr}:${port}` : null), webhookToken).then((handled) => {
        if (!handled) { res.writeHead(404); res.end("not found"); }
      }).catch(() => { res.writeHead(500); res.end("error"); });
      return;
    }
    void serveStatic(req, url.pathname, staticDir, res);
  });

  server.on("upgrade", (req, socket) => {
    if (!hostOk(req.headers.host)) return void socket.destroy();
    if (!originOk(req.headers.origin as string | undefined)) return void socket.destroy();
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // Two token-gated channels: /ws (the event mirror) and /pty (the human terminal,
    // whose output never reaches the bus/model). Everything else is rejected.
    const isPty = url.pathname === "/pty";
    if ((url.pathname !== "/ws" && !isPty) || !tokenOk(url.searchParams.get("token"), token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return void socket.destroy();
    }
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") return void socket.destroy();
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    // /pty: bridge this socket to a real pseudo-terminal in the tab's cwd. Kept
    // entirely separate from the event mirror below — nothing here reaches the bus.
    if (isPty) {
      attachPty(socket, cwdForTab(bridge, Number(url.searchParams.get("tabId"))) ?? process.cwd(), Number(url.searchParams.get("cols")) || 80, Number(url.searchParams.get("rows")) || 24);
      return;
    }

    const send = (w: unknown) => {
      try {
        socket.write(encodeText(JSON.stringify(w)));
      } catch {
        /* socket gone */
      }
    };
    const client = { send, socket };
    const sendSnapshot = () => {
      for (const a of bridge.getAgents()) {
        send({ type: "agent.created", tabId: a.id, name: a.name, cwd: a.cwd, model: a.model, mode: a.mode, imageInput: a.imageInput, documentInput: a.documentInput, contextLimit: a.contextLimit, contextUsed: a.contextUsed, tokens: a.tokens, cost: a.cost });
        if (a.busy) send({ type: "agent.busy", tabId: a.id, busy: true });
      }
    };

    // Who this client just reached. FIRST frame on every connection, before the
    // snapshot or any replay, so a client resuming against a restarted server can
    // throw away the old picture before the new one starts arriving.
    send({ type: "server.hello", instance, startedAt });

    // First connect → snapshot current agents. Reconnect (?since=N) → replay the
    // events missed since seq N; if the gap exceeds the buffer, resync state first.
    // The connect handler is synchronous, so no event can slip in between reading
    // the ring and joining the broadcast set (no dup, no gap).
    const cutoff = seq;
    const sinceRaw = url.searchParams.get("since");
    const since = sinceRaw != null && sinceRaw !== "" ? Number(sinceRaw) : null;
    // A cursor only means something against the instance that issued it. The client
    // echoes the instance its `since` was counted against; if that is not us, these
    // are another process's seq numbers and replaying against them is nonsense —
    // most visibly on a restart, where a fresh ring is empty and a `since`-only
    // reconnect would leave the browser showing a whole roster that no longer
    // exists. `since > seq` catches the same thing for a client too old to echo it.
    const cursorInstance = url.searchParams.get("instance");
    const foreignCursor = (cursorInstance != null && cursorInstance !== instance) || (since != null && since > seq);
    if (since != null && Number.isFinite(since) && !foreignCursor) {
      if (ring.length && since < ring[0]!.seq - 1) sendSnapshot();
      for (const w of ring) if (w.seq > since) send(w);
    } else {
      // Fresh connect (e.g. a page reload, where the client has no lastSeq):
      // send the agent roster, THEN replay the buffered event history so each
      // tab's transcript is rebuilt. Without the replay the chat rail is empty
      // for every tab, so switching floors appears to show the same (empty)
      // content while only the header/roster (from the snapshot) updates. The
      // store dedupes repeat agent.created and rebuilds transcripts from the
      // replayed line/tool events.
      sendSnapshot();
      for (const w of ring) send(w);
    }
    send({ type: "commands", list: bridge.getCommands() }); // slash-command registry
    send({ type: "@sync", seq: cutoff }); // high-water mark for the next reconnect
    clients.add(client);

    const cleanup = () => {
      clients.delete(client);
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    };
    const decode = makeDecoder(
      (text) => handleClientMessage(bridge, text, send),
      cleanup,
      (p) => {
        try {
          socket.write(frame(0xa, p));
        } catch {
          /* ignore */
        }
      },
    );
    socket.on("data", (c: Buffer) => {
      try {
        decode(c);
      } catch {
        cleanup();
      }
    });
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 7777, bindHost, () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;

  // Shutdown broadcast: the browser's office floor is built from agent.created
  // events and is NOT cleared when the socket drops — a reconnect to a fresh
  // server replays from an empty ring, so the old figures would stand there
  // forever. Tell every client the roster is gone BEFORE the bus is unsubscribed
  // and the sockets are torn down.
  //
  // agent.closed retires each session tab and its figure one by one (so a client
  // that only understands that event still empties its roster); floor.reset then
  // wipes what no per-agent event covers — manual figures, sub-agents, the chat
  // rail, and the transcripts agent.closed deliberately leaves behind.
  const clearFloor = (reason: string) => {
    for (const a of bridge.getAgents()) bridge.bus.emit({ type: "agent.closed", tabId: a.id, name: a.name });
    bridge.bus.emit({ type: "floor.reset", reason });
  };

  let closed = false;
  const handle: ServerHandle = {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    token,
    webhookToken,
    port,
    clients: () => clients.size,
    lanUrl: lanAddr ? `http://${lanAddr}:${port}` : null,
    setPublicUrl: (u) => { publicUrl = u; },
    close: () =>
      new Promise<void>((resolve) => {
        if (closed) return resolve();
        closed = true;
        process.off("exit", onExit);
        for (const sig of SHUTDOWN_SIGNALS) { const fn = onSignal[sig]; if (fn) process.off(sig, fn); }
        clearFloor("serve stopped");
        busUnsub();
        jobsUnsub();
        killAllPtys();
        for (const c of clients) {
          try {
            c.socket.destroy();
          } catch {
            /* ignore */
          }
        }
        server.close(() => resolve());
      }),
  };

  // Process teardown runs the SAME cleanup as `/serve stop`. close() is async, but
  // everything that matters here — the agent.closed broadcast and the socket
  // writes it triggers — happens synchronously, so it still lands under
  // process.on("exit"), where no async continuation would ever run. The listeners
  // are removed by close() so a restarted server doesn't leak them.
  const onExit = () => void handle.close();
  // One bound listener per signal rather than one shared handler: the signal name
  // is then closed over, not read from the emitted argument, so the exit code is
  // right no matter who raised it.
  const onSignal: Partial<Record<NodeJS.Signals, () => void>> = {};
  process.on("exit", onExit);
  for (const sig of SHUTDOWN_SIGNALS) {
    const fn = () => {
      void handle.close();
      process.exit(128 + SIGNAL_NUMBERS[sig]);
    };
    onSignal[sig] = fn;
    process.on(sig, fn);
  }

  return handle;
}

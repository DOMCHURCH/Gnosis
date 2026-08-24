// `dom serve`: a localhost-only HTTP + WebSocket server that mirrors the running
// engines to a browser. It is a VIEW/remote-control over the same engines the Ink
// TUI drives — never a second agent. Every event on the bus is forwarded to
// connected clients; client messages route back through the AppBridge.
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
import { promises as fs } from "node:fs";
import path from "node:path";
import { WEB_ASSETS_DIR } from "./install.js";
import { buildTree, readFileInRoot } from "./filetree.js";
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
async function handleApi(req: http.IncomingMessage, url: URL, bridge: AppBridge, res: http.ServerResponse, getPublicUrl: () => string | null, getLanUrl: () => string | null): Promise<boolean> {
  // Serve info: the public tunnel URL (if `/serve --public` is up), so the WEBHOOKS
  // tab can show the URL external services actually need to reach.
  if (url.pathname === "/api/serveinfo") {
    sendJson(res, 200, { public: getPublicUrl(), lan: getLanUrl() });
    return true;
  }
  // Webhook inspector: the whole ring buffer, plus the public URL for the generator.
  if (url.pathname === "/api/webhooks") {
    sendJson(res, 200, { webhooks: webhooks.list(), labels: webhooks.labels(), public: getPublicUrl() });
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
    const tabId = Number(url.searchParams.get("tabId"));
    const cwd = cwdForTab(bridge, tabId);
    if (cwd == null) { sendJson(res, 404, { error: "unknown tab" }); return true; }
    // Hide temp/noise files (.gitignore/.domignore + auto-excludes) from the browser.
    sendJson(res, 200, await buildTree(cwd, { ignore: buildIgnorer(cwd, false) }));
    return true;
  }
  if (url.pathname === "/api/file") {
    const tabId = Number(url.searchParams.get("tabId"));
    const rel = url.searchParams.get("path") ?? "";
    const cwd = cwdForTab(bridge, tabId);
    if (cwd == null) { sendJson(res, 404, { error: "unknown tab" }); return true; }
    const preview = await readFileInRoot(cwd, rel);
    if (!preview) { sendJson(res, 404, { error: "not found" }); return true; }
    sendJson(res, 200, preview);
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

async function serveStatic(pathname: string, staticDir: string, res: http.ServerResponse): Promise<void> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const full = path.join(staticDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  // Path-traversal guard: the resolved file must stay inside staticDir.
  if (!full.startsWith(path.resolve(staticDir))) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    const body = await fs.readFile(full);
    res.writeHead(200, { "content-type": MIME[path.extname(full)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    if (rel === "/index.html") {
      res.writeHead(200, { "content-type": MIME[".html"]! });
      res.end(PLACEHOLDER_HTML); // no built frontend yet → placeholder
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
  port: number;
  clients(): number;
  /** The LAN URL (base, no token); null only when the machine has no LAN address. */
  lanUrl: string | null;
  /** Record the public tunnel URL (base, no token) so /api/serveinfo exposes it. */
  setPublicUrl(url: string | null): void;
  close(): Promise<void>;
}

export async function startServer(bridge: AppBridge, opts: { port?: number } = {}): Promise<ServerHandle> {
  const token = crypto.randomBytes(24).toString("base64url");
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
    if (!hostOk(req.headers.host)) {
      res.writeHead(403);
      res.end("forbidden host");
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const tok = url.searchParams.get("token") ?? (req.headers["x-dom-token"] as string | undefined);
    if (!tokenOk(tok, token)) {
      res.writeHead(401);
      res.end("unauthorized");
      return;
    }
    // Webhook capture: any method to /webhook/:label is stored in the ring buffer
    // and announced on the bus. The token gate above already protects it.
    if (url.pathname.startsWith("/webhook/")) {
      void (async () => {
        const label = decodeURIComponent(url.pathname.slice("/webhook/".length)).replace(/\/+$/, "") || "default";
        const body = await readBody(req, 256 * 1024);
        const entry = webhooks.record({ label, method: req.method ?? "POST", contentType: String(req.headers["content-type"] ?? ""), headers: flatHeaders(req.headers), body, statusReturned: 200 });
        bridge.bus.emit({ type: "webhook.received", id: entry.id, label: entry.label, method: entry.method, size: entry.size });
        sendJson(res, 200, { ok: true, id: entry.id, label: entry.label });
      })().catch(() => { res.writeHead(500); res.end("error"); });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      void handleApi(req, url, bridge, res, () => publicUrl, () => (lanAddr ? `http://${lanAddr}:${port}` : null)).then((handled) => {
        if (!handled) { res.writeHead(404); res.end("not found"); }
      }).catch(() => { res.writeHead(500); res.end("error"); });
      return;
    }
    void serveStatic(url.pathname, staticDir, res);
  });

  server.on("upgrade", (req, socket) => {
    if (!hostOk(req.headers.host)) return void socket.destroy();
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
        send({ type: "agent.created", tabId: a.id, name: a.name, cwd: a.cwd, model: a.model, mode: a.mode, imageInput: a.imageInput, documentInput: a.documentInput, contextLimit: a.contextLimit });
        if (a.busy) send({ type: "agent.busy", tabId: a.id, busy: true });
      }
    };

    // First connect → snapshot current agents. Reconnect (?since=N) → replay the
    // events missed since seq N; if the gap exceeds the buffer, resync state first.
    // The connect handler is synchronous, so no event can slip in between reading
    // the ring and joining the broadcast set (no dup, no gap).
    const cutoff = seq;
    const sinceRaw = url.searchParams.get("since");
    const since = sinceRaw != null && sinceRaw !== "" ? Number(sinceRaw) : null;
    if (since != null && Number.isFinite(since)) {
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

  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    token,
    port,
    clients: () => clients.size,
    lanUrl: lanAddr ? `http://${lanAddr}:${port}` : null,
    setPublicUrl: (u) => { publicUrl = u; },
    close: () =>
      new Promise<void>((resolve) => {
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
}

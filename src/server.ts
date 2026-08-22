// `dom serve`: a localhost-only HTTP + WebSocket server that mirrors the running
// engines to a browser. It is a VIEW/remote-control over the same engines the Ink
// TUI drives — never a second agent. Every event on the bus is forwarded to
// connected clients; client messages route back through the AppBridge.
//
// Security (all enforced here, before anything else runs):
//   - binds 127.0.0.1 ONLY (never 0.0.0.0)
//   - rejects any request whose Host header isn't localhost (DNS-rebinding defense)
//   - a random per-startup token is required on every HTTP request and WS connect
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
import type { AppBridge, DomEvent } from "./events.js";
import type { PermissionAnswer } from "./permissions.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Host-header allowlist: only loopback names are accepted (blocks DNS rebinding). */
export function hostOk(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, "").toLowerCase().replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
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
    case "input":
      bridge.onInput?.(Number(msg.tabId), String(msg.text ?? ""));
      break;
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
    case "agent.create":
      bridge.onCreateAgent?.(msg.name, msg.purpose);
      break;
    case "agent.close":
      bridge.onCloseAgent?.(Number(msg.tabId));
      break;
  }
}

export interface ServerHandle {
  url: string;
  token: string;
  port: number;
  clients(): number;
  close(): Promise<void>;
}

export async function startServer(bridge: AppBridge, opts: { port?: number } = {}): Promise<ServerHandle> {
  const token = crypto.randomBytes(24).toString("base64url");
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
    void serveStatic(url.pathname, staticDir, res);
  });

  server.on("upgrade", (req, socket) => {
    if (!hostOk(req.headers.host)) return void socket.destroy();
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/ws" || !tokenOk(url.searchParams.get("token"), token)) {
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
        send({ type: "agent.created", tabId: a.id, name: a.name, cwd: a.cwd, model: a.model, mode: a.mode });
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
      sendSnapshot();
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
    server.listen(opts.port ?? 7777, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    token,
    port,
    clients: () => clients.size,
    close: () =>
      new Promise<void>((resolve) => {
        busUnsub();
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

// Verify (web file upload): a browser attaches a PDF, an image, and a text file to
// a message; the bytes travel over the WS as base64 attachments, the real serve
// stack (server → bridge.onInput → engine) partitions them, and the outbound
// provider request carries the PDF as a `file` content block, the image as an
// `image_url` block, and the text file inlined into the user text. Also checks the
// modality gate: a PDF on a text-only model degrades to a note, never a file block.
import net from "node:net";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;
const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dom-cwd-"));

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- stub the provider: capture the outbound request body, return a tiny SSE ----
let captured = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("/chat/completions")) {
    try { captured = JSON.parse(init.body); } catch { captured = null; }
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
        c.enqueue(enc.encode('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0}}\n\n'));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  return realFetch(url, init);
};

const { EventBus, createBridge } = await import("../dist/events.js");
const { startServer } = await import("../dist/server.js");
const { Engine } = await import("../dist/engine.js");
const { runServeHeadless } = await import("../dist/servehost.js");
const { createSession } = await import("../dist/config.js");
const { serialize, partitionAttachments } = await import("../dist/messages.js");

const pdfB64 = Buffer.from("%PDF-1.4 fake pdf bytes").toString("base64");
const txtB64 = Buffer.from("hello from a text file").toString("base64");

// --- unit: partitionAttachments sorts by MIME --------------------------------
const part = partitionAttachments([
  { name: "doc.pdf", mime: "application/pdf", data: pdfB64 },
  { name: "shot.png", mime: "image/png", data: "AAAA" },
  { name: "notes.txt", mime: "text/plain", data: txtB64 },
]);
ok("partition: PDF → files", part.files.length === 1 && part.files[0].source === "doc.pdf");
ok("partition: image → images", part.images.length === 1 && part.images[0].mime === "image/png");
ok("partition: text file → inlined text", part.inlineText.includes("hello from a text file") && part.inlineText.includes("notes.txt"));

// --- unit: serialize emits a `file` block only when documents are supported ---
const msg = [{ role: "user", text: "read this", files: [{ source: "doc.pdf", mime: "application/pdf", data: pdfB64 }] }];
const withDoc = serialize(msg, "sys", null, { documents: true });
const um = withDoc.find((m) => m.role === "user");
const fileBlock = Array.isArray(um.content) && um.content.find((p) => p.type === "file");
ok("serialize(documents:true): user turn carries a file content block", !!fileBlock);
ok("serialize(documents:true): file_data is a PDF data URL", fileBlock?.file?.file_data?.startsWith("data:application/pdf;base64,"));
ok("serialize(documents:true): filename preserved", fileBlock?.file?.filename === "doc.pdf");
const noDoc = serialize(msg, "sys", null, { documents: false });
const um2 = noDoc.find((m) => m.role === "user");
ok("serialize(documents:false): PDF degrades to a text note, no file block", typeof um2.content === "string" && /can't read documents/.test(um2.content));

// --- end-to-end through the real serve stack (a "file"-capable model) ---------
const models = [{
  id: "vision/docs", name: "Docs", context_length: 200000,
  pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 },
  supported_parameters: ["tools"], input_modalities: ["text", "image", "file"],
}];
const session = createSession(cwd, "vision/docs", "yolo"); // yolo → no edit prompts
const engine = new Engine({ apiKey: "test-key", cwd, systemPrompt: "sys", models, session, skills: [], autoCommit: false });
ok("engine reports document input support for a file-capable model", engine.supportsDocumentInput() === true);

const bus = new EventBus();
const bridge = createBridge(bus);
void runServeHeadless(engine, bridge); // wires bridge.onInput etc.; never resolves
const server = await startServer(bridge, { port: 0 });

// --- minimal browser-like WS client (masked frames), mirrors s15-webui -------
function encodeClient(str) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, out]);
}
function decodeServer(buf, onText) {
  let off = 0;
  while (buf.length - off >= 2) {
    const opcode = buf[off] & 0x0f;
    let len = buf[off + 1] & 0x7f;
    let p = off + 2;
    if (len === 126) { if (buf.length - off < 4) break; len = buf.readUInt16BE(off + 2); p = off + 4; }
    else if (len === 127) { if (buf.length - off < 10) break; len = Number(buf.readBigUInt64BE(off + 2)); p = off + 10; }
    if (buf.length - p < len) break;
    if (opcode === 0x1) onText(buf.subarray(p, p + len).toString("utf8"));
    off = p + len;
  }
  return buf.subarray(off);
}
function browser(token) {
  return new Promise((resolve) => {
    const socket = net.connect(server.port, "127.0.0.1", () => {
      const key = crypto.randomBytes(16).toString("base64");
      socket.write(`GET /ws?token=${token} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    let up = false;
    const backlog = [];
    const waiters = [];
    const deliver = (o) => {
      const i = waiters.findIndex((w) => w.pred(o));
      if (i >= 0) { const [w] = waiters.splice(i, 1); w.done(o); } else backlog.push(o);
    };
    const api = {
      send: (o) => socket.write(encodeClient(JSON.stringify(o))),
      waitFor: (pred, ms = 5000) =>
        new Promise((res, rej) => {
          const i = backlog.findIndex(pred);
          if (i >= 0) return res(backlog.splice(i, 1)[0]);
          const t = setTimeout(() => rej(new Error("timeout")), ms);
          waiters.push({ pred, done: (o) => { clearTimeout(t); res(o); } });
        }),
      close: () => socket.destroy(),
    };
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!up) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        up = true;
        buf = buf.subarray(idx + 4);
        resolve(api);
      }
      buf = decodeServer(buf, (t) => { try { deliver(JSON.parse(t)); } catch {} });
    });
  });
}

const b = await browser(server.token);
try {
  const snap = await b.waitFor((e) => e.type === "agent.created");
  ok("snapshot advertises image + document capability to the client", snap.documentInput === true && snap.imageInput === true);

  // Send exactly what the web composer sends: text + a PDF + an image + a text file.
  b.send({
    type: "input",
    tabId: snap.tabId,
    text: "summarize the attached PDF",
    attachments: [
      { name: "report.pdf", mime: "application/pdf", data: pdfB64 },
      { name: "chart.png", mime: "image/png", data: "iVBORw0KGgo=" },
      { name: "notes.txt", mime: "text/plain", data: txtB64 },
    ],
  });

  // Wait for the engine to actually issue the provider request.
  const start = Date.now();
  while (!captured && Date.now() - start < 6000) await new Promise((r) => setTimeout(r, 50));
  ok("the engine issued a provider request", !!captured);

  const userMsg = captured?.messages?.filter((m) => m.role === "user").pop();
  const parts = Array.isArray(userMsg?.content) ? userMsg.content : [];
  const fBlock = parts.find((p) => p.type === "file");
  const iBlock = parts.find((p) => p.type === "image_url");
  const tBlock = parts.find((p) => p.type === "text");
  ok("PDF reached the model as a `file` content block", !!fBlock && fBlock.file.filename === "report.pdf");
  ok("the file block carries the base64 PDF as a data URL", fBlock?.file?.file_data?.startsWith("data:application/pdf;base64,"));
  ok("image reached the model as an `image_url` block", !!iBlock && iBlock.image_url.url.startsWith("data:image/png;base64,"));
  ok("text file was inlined into the user text", !!tBlock && tBlock.text.includes("hello from a text file") && tBlock.text.includes("summarize the attached PDF"));
} catch (e) {
  ok(`round-trip completed without timeout (${e.message})`, false);
}

b.close();
console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);

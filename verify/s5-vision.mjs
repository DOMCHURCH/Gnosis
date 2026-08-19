// Verify (feature 5 — vision): view_image loads an image and attaches it to the
// next message ONLY on a model whose input_modalities include "image"; a text-only
// model errors clearly. loadImage sniffs the MIME and rejects non-images. serialize
// emits an image_url content block when images are enabled and degrades to a text
// note otherwise (so a runtime model switch stays valid). Fake home, offline.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { loadImage, isImagePath } = await import("../dist/tools/viewimage.js");
const { serialize } = await import("../dist/messages.js");
const { Engine } = await import("../dist/engine.js");
const { createSession } = await import("../dist/config.js");

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

// A minimal valid 1x1 PNG.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// --- isImagePath -------------------------------------------------------------
ok("isImagePath: true for png/JPG/webp", isImagePath("a.png") && isImagePath("b.JPG") && isImagePath("c.webp"));
ok("isImagePath: false for non-images", !isImagePath("a.txt") && !isImagePath("b.ts"));

// --- loadImage: sniffs a real PNG, rejects a non-image ----------------------
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dom-vis-"));
const prev = process.cwd();
process.chdir(dir);
await fs.writeFile(path.join(dir, "pic.png"), Buffer.from(PNG_B64, "base64"));
await fs.writeFile(path.join(dir, "fake.dat"), "not an image at all");
{
  const li = await loadImage(path.resolve(dir, "pic.png"));
  ok("loadImage reads + magic-byte-sniffs a PNG", !("error" in li) && li.mime === "image/png" && li.data.length > 0 && li.source.includes("pic.png"));
  const bad = await loadImage(path.resolve(dir, "fake.dat"));
  ok("loadImage rejects a non-image", "error" in bad && /not a recognized image/.test(bad.error));
  const missing = await loadImage(path.resolve(dir, "nope.png"));
  ok("loadImage reports a missing file", "error" in missing);
}

// --- serialize: image_url block when enabled; text note when disabled -------
{
  const msgs = [{ role: "user", text: "look at this", images: [{ source: "pic.png", mime: "image/png", data: PNG_B64 }] }];
  const withImg = serialize(msgs, "sys", null, { images: true });
  const u = withImg.find((w) => w.role === "user");
  ok("serialize emits an image_url content block when the model supports images", Array.isArray(u.content) && u.content.some((p) => p.type === "image_url" && p.image_url.url === `data:image/png;base64,${PNG_B64}`));
  ok("...and keeps the text part", Array.isArray(u.content) && u.content.some((p) => p.type === "text" && p.text === "look at this"));

  const noImg = serialize(msgs, "sys", null, { images: false });
  const u2 = noImg.find((w) => w.role === "user");
  ok("serialize degrades images to a text note when the model can't view them", typeof u2.content === "string" && /can't view images/.test(u2.content) && u2.content.includes("pic.png"));
}

// --- engine end-to-end: gate on input_modalities ----------------------------
const sse = (b) => new Response(b, { status: 200, headers: { "content-type": "text/event-stream" } });
const done = `data: {"choices":[{"delta":{"content":"seen"}}]}\n\ndata: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n`;
const toolSSE = (name, args) =>
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n` +
  `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n`;
let pending = null, served = false;
globalThis.fetch = async (url) => {
  if (String(url).includes("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
  if (pending && !served) { served = true; return sse(toolSSE(pending.name, pending.args)); }
  return sse(done);
};
const vmodel = { id: "vision", name: "V", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"], input_modalities: ["text", "image"] };
const tmodel = { id: "textonly", name: "T", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"], input_modalities: ["text"] };

async function turn(engine, name, args) {
  pending = name ? { name, args } : null; served = false;
  const results = [];
  await engine.run("go", { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult(_c, r) { results.push(r); }, onSystem() {}, async requestPermission() { return "yes"; } });
  return results[0];
}

// vision model: view_image loads and attaches
{
  const engine = new Engine({ apiKey: "test", cwd: dir, systemPrompt: "t", models: [vmodel], session: createSession(dir, "vision", "yolo"), skills: [], autoCommit: false });
  ok("supportsImageInput() true for a vision model", engine.supportsImageInput() === true);
  const r = await turn(engine, "view_image", { path: "pic.png" });
  ok("view_image succeeds on a vision model", !r.isError && /Loaded image/.test(r.output));
  const injected = engine.messages.find((m) => m.role === "user" && m.images && m.images.length);
  ok("...the image rides in on a following user message (image content block)", !!injected && injected.images[0].mime === "image/png");
}

// text-only model: view_image is refused, nothing attached
{
  const engine = new Engine({ apiKey: "test", cwd: dir, systemPrompt: "t", models: [tmodel], session: createSession(dir, "textonly", "yolo"), skills: [], autoCommit: false });
  ok("supportsImageInput() false for a text-only model", engine.supportsImageInput() === false);
  const r = await turn(engine, "view_image", { path: "pic.png" });
  ok("view_image errors clearly on a text-only model", r.isError && /can't view images/.test(r.output));
  ok("...and no image is attached", !engine.messages.some((m) => m.role === "user" && m.images && m.images.length));
}

// setNextUserImages: an @image typed in the TUI attaches to the next user turn
{
  const engine = new Engine({ apiKey: "test", cwd: dir, systemPrompt: "t", models: [vmodel], session: createSession(dir, "vision", "yolo"), skills: [], autoCommit: false });
  engine.setNextUserImages([{ source: "pic.png", mime: "image/png", data: PNG_B64 }]);
  await turn(engine, null); // plain turn, no tool call
  const um = engine.messages.find((m) => m.role === "user" && m.text === "go" && m.images);
  ok("setNextUserImages attaches images to the next user message", !!um && um.images.length === 1 && um.images[0].source === "pic.png");
}

process.chdir(prev);
await fs.rm(dir, { recursive: true, force: true });
await fs.rm(fake, { recursive: true, force: true });
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

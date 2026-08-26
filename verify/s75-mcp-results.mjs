// Verify (MCP tool result rendering: text, files, images).
//
// The pipeline has four links and each used to lose something different:
//   text  — tool.end -> store -> groupChat -> the chat rail's tool block
//   files — a path named in the result text -> fileOutput -> rich rendering
//   image — base64 -> ImagePart (the model) AND a file on disk (the user)
//   serve — that file is outside every session root, so it needs its own route
//
// Text and grouping were already correct and are pinned here so they stay that
// way; the file and image links are new.
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const imp = (f) => import(pathToFileURL(path.resolve(here, f)).href);

const home = await fs.mkdtemp(path.join(os.tmpdir(), "gnosis-mcpres-"));
process.env.USERPROFILE = home;
process.env.HOME = home;

const { groupChat } = await imp("../web/src/chatgroups.js");
const { fileOutputFor } = await imp("../web/src/filekind.js");
const { saveScreenshot, screenshotName, isScreenshotName, extForMime } = await imp("../dist/screenshots.js");
const { screenshotsDir } = await imp("../dist/config.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };
const line = (o) => ({ key: "k" + Math.random(), tabId: 1, from: "dom", kind: "tool", epoch: 0, time: "10:00", ...o });

// --- 1. TEXT: an MCP call renders like any built-in call --------------------
{
  const [g] = groupChat([line({ tool: "mcp__context7__get_docs", primary: "react", secondary: "", ok: true, summary: "3.2k chars", detail: "full docs here" })]);
  ok("an MCP tool produces a tool block in the rail", g && g.kind === "tool");
  ok("...carrying the call signature", g.tool.tool === "mcp__context7__get_docs" && g.tool.primary === "react");
  ok("...the collapsed summary", g.tool.summary === "3.2k chars");
  ok("...and the full detail for expansion", g.tool.detail === "full docs here");
  ok("...with its ok flag", g.tool.ok === true);
  const [bad] = groupChat([line({ tool: "mcp__x__y", primary: "", secondary: "", ok: false, summary: "boom", detail: "stack" })]);
  ok("a failed MCP call survives grouping too", bad.kind === "tool" && bad.tool.ok === false);
  // The grouper must not swallow a tool block for having no text segments.
  ok("tool blocks are kept despite having no text segments", groupChat([line({ tool: "mcp__a__b", primary: "", secondary: "", ok: true, summary: "s", detail: "d" })]).length === 1);
}

// --- 2. FILES: a path in an MCP result becomes rich output ------------------
{
  const out = fileOutputFor("mcp__computer-use__screenshot", "", "screenshot saved /tmp/shot.png");
  ok("a path in MCP output yields a fileOutput", !!out);
  ok("...resolved to the file", out.path === "/tmp/shot.png");
  ok("...classified as an image", out.kind === "image");
  ok("...and marked verify, so a non-file costs nothing", out.verify === true);

  ok("a windows path is picked up too", fileOutputFor("mcp__x__y", "", "wrote C:\\tmp\\report.pdf").kind === "pdf");
  // Windows absolute paths kept their drive letter only after this fix: the
  // scanner used to match from the backslash on, yielding a path that resolves
  // nowhere, so a bash- or MCP-produced artefact silently failed to render.
  {
    const win = "C:" + String.fromCharCode(92) + "Users" + String.fromCharCode(92) + "me" + String.fromCharCode(92) + "shot.png";
    const o = fileOutputFor("mcp__x__y", "", "saved " + win);
    ok("a windows absolute path keeps its drive letter", o && o.path === win);
    const posix = "/home/me/shot.png";
    ok("a posix absolute path is unchanged", fileOutputFor("mcp__x__y", "", "saved " + posix).path === posix);
    ok("bash gets the same fix (it had the same bug)", fileOutputFor("bash", "", "saved " + win).path === win);
  }
  ok("a csv is classified", fileOutputFor("mcp__x__y", "", "./out/data.csv").kind === "csv");
  ok("prose with no path yields nothing", fileOutputFor("mcp__x__y", "", "did the thing") === null);
  // Unchanged behaviour for everything that already worked.
  ok("write still yields its own output", fileOutputFor("write", "a/b.png", "").kind === "image");
  ok("a non-MCP unknown tool still yields nothing", fileOutputFor("read", "", "/tmp/shot.png") === null);
}

// --- 3. IMAGES: bytes reach disk with a servable name -----------------------
{
  ok("png/jpeg/gif/webp map to extensions", extForMime("image/png") === ".png" && extForMime("image/jpeg") === ".jpg");
  ok("an unknown content type is refused, not guessed", extForMime("image/tiff") === null);
  ok("...and yields no filename", screenshotName("image/tiff", new Date()) === null);

  const at = new Date("2026-08-26T21:40:05.123Z");
  const name = screenshotName("image/png", at);
  ok("the name is timestamped and sortable", name === "2026-08-26T21-40-05-123Z.png");
  ok("several images in one result get distinct names", screenshotName("image/png", at, "-2") !== name);

  // 1x1 png
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const saved = await saveScreenshot(png, "image/png", at);
  ok("the file is written under ~/.dom/screenshots", saved !== null && saved.startsWith(screenshotsDir()));
  const bytes = await fs.readFile(saved);
  ok("...with the real decoded bytes", bytes.length === Buffer.from(png, "base64").length);
  ok("...a genuine PNG header", bytes.subarray(0, 4).toString("hex") === "89504e47");
  ok("an unservable type writes nothing", (await saveScreenshot(png, "image/tiff")) === null);
}

// --- 4. SERVING: the endpoint's name guard ---------------------------------
{
  ok("a plain image basename is accepted", isScreenshotName("2026-08-26T21-40-05-123Z.png"));
  for (const bad of ["../../.dom/.env", "a/b.png", "a\\b.png", "..\\x.png", "notes.txt", "", "shot.png.exe"]) {
    ok(`traversal/junk rejected: ${JSON.stringify(bad)}`, !isScreenshotName(bad));
  }
}

await fs.rm(home, { recursive: true, force: true }).catch(() => {});
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);

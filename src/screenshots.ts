// Images that tools hand back (an MCP screenshot today) persisted to disk.
//
// Two reasons they go to a file rather than living only as base64 in the message
// history: the user can open the actual picture afterwards, and the browser can
// show a thumbnail without the bytes riding the websocket a second time.
//
// They land in ~/.dom/screenshots, which is outside every session root — so
// /api/file/raw will not serve them (it refuses anything outside the root, and
// that guard should stay exactly as strict as it is). The dedicated
// /api/screenshot endpoint serves this directory and nothing else, by basename
// only, so there is no traversal surface to get wrong.

import { promises as fs } from "node:fs";
import path from "node:path";
import { screenshotsDir } from "./config.js";

/** Extension for a content type; unknown types are refused rather than guessed. */
const EXT_FOR_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

export function extForMime(mime: string): string | null {
  return EXT_FOR_MIME[String(mime || "").toLowerCase().trim()] ?? null;
}

/** A sortable, collision-free filename: 2026-08-26T21-40-05-123Z.png */
export function screenshotName(mime: string, at: Date, suffix = ""): string | null {
  const ext = extForMime(mime);
  if (!ext) return null;
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  return `${stamp}${suffix}${ext}`;
}

/** True when `name` is a plain basename this directory could have produced —
 * no separators, no traversal, and an image extension we serve. */
export function isScreenshotName(name: string): boolean {
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) return false;
  return Object.values(EXT_FOR_MIME).includes(path.extname(name).toLowerCase());
}

/**
 * Write one base64 image into ~/.dom/screenshots and return its absolute path.
 * Returns null for a content type we do not serve, rather than writing bytes the
 * browser would then refuse to display.
 */
export async function saveScreenshot(data: string, mime: string, at = new Date(), suffix = ""): Promise<string | null> {
  const name = screenshotName(mime, at, suffix);
  if (!name) return null;
  const dir = screenshotsDir();
  await fs.mkdir(dir, { recursive: true });
  const full = path.join(dir, name);
  await fs.writeFile(full, Buffer.from(data, "base64"));
  return full;
}

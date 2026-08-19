// view_image: load an image file so a vision model can see it. The bytes are
// base64-encoded and attached to the NEXT message (an image content block) via the
// engine — the tool result itself is just a text confirmation. Gated on the active
// model actually accepting image input (ctx.imageInput). loadImage is shared with
// the App's @image input path.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ImagePart } from "../messages.js";
import type { ViewImageArgs } from "./schemas.js";
import type { ToolContext, ToolResult } from "./index.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** True for a path whose extension is a supported image type. */
export function isImagePath(p: string): boolean {
  return Object.prototype.hasOwnProperty.call(EXT_MIME, path.extname(p).toLowerCase());
}

/** Detect the image type from magic bytes; null if it isn't a known image. */
function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function relOf(abs: string): string {
  const rel = path.relative(process.cwd(), abs).split(path.sep).join("/");
  return rel && !rel.startsWith("..") ? rel : abs;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export interface LoadedImage extends ImagePart {
  bytes: number;
}

/**
 * Read + validate an image file and return it base64-encoded, or an error string.
 * MIME is taken from magic bytes first, then the extension. Rejects non-images and
 * anything over 10 MB.
 */
export async function loadImage(absPath: string): Promise<LoadedImage | { error: string }> {
  const rel = relOf(absPath);
  let buf: Buffer;
  try {
    buf = await fs.readFile(absPath);
  } catch (e) {
    return { error: `view_image: ${(e as Error).message}` };
  }
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    return { error: `view_image: ${rel} is ${fmtBytes(buf.byteLength)} — too large (max 10 MB).` };
  }
  const mime = sniffMime(buf) ?? EXT_MIME[path.extname(absPath).toLowerCase()] ?? null;
  if (!mime) {
    return { error: `view_image: ${rel} is not a recognized image (expected png, jpg, jpeg, gif, or webp).` };
  }
  return { source: rel, mime, data: buf.toString("base64"), bytes: buf.byteLength };
}

export async function runViewImage(args: ViewImageArgs, _signal?: AbortSignal, ctx?: ToolContext): Promise<ToolResult> {
  if (!ctx?.imageInput) {
    return {
      output:
        "view_image: the active model can't view images (its input is text-only). Switch to a vision model with " +
        "/model, then try again.",
      isError: true,
    };
  }
  const abs = path.resolve(process.cwd(), args.path);
  const r = await loadImage(abs);
  if ("error" in r) return { output: r.error, isError: true };
  ctx.attachImage?.({ source: r.source, mime: r.mime, data: r.data });
  return {
    output: `Loaded image ${r.source} (${r.mime}, ${fmtBytes(r.bytes)}) — attached to the next message for you to view.`,
    isError: false,
  };
}

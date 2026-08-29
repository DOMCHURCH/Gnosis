// Generates the app icon — electron/icon.ico (Windows) and electron/icon.png.
//
// Drawn in code from the shared wordmark (electron/wordmark.js) rather than
// checked in as an opaque binary, so the icon, the tray mark and the top-bar
// logo are provably the same artwork.
//
// Plain Node: a small software rasteriser plus a minimal PNG encoder (zlib is in
// core), wrapped in an ICO container. Windows accepts PNG-compressed ICO entries,
// so a 256px icon is one small chunk instead of a raw 256KB bitmap.
//
// Sizes carry different artwork on purpose: the full GNOSIS wordmark is 35 pixels
// wide in font units and turns to mush below ~128px, so the small entries — the
// ones Windows actually shows in the taskbar and the tray — carry the "G" mark.

import zlib from "node:zlib";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { textMask, markMask } from "../electron/wordmark.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIZES = [256, 128, 64, 48, 32, 16];

// Claymorphism palette: cyan at the centre, magenta at the edges. The edge is a
// deeper magenta than the UI accent (#e879f9): interpolating brand cyan to brand
// magenta across the diagonal lands on a pale lavender in the middle, and white
// letters wash out on it. Driving the edge darker keeps the wordmark readable at
// taskbar size, which is the only size that matters here.
const CYAN = [0x2d, 0xd9, 0xf0];
const MAGENTA = [0x8b, 0x1d, 0xa8];
const INK = [0xf7, 0xfa, 0xff];

// ---------------------------------------------------------------- PNG encoding
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const o = y * (size * 4 + 1);
    raw[o] = 0; // filter: none
    rgba.copy(raw, o + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------- rendering
/** Coverage of a rounded square, supersampled so the corners are not stepped. */
function roundedRectMask(size, radius, inset, ss = 4) {
  const m = new Float32Array(size * size);
  const lo = inset;
  const hi = size - inset;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          if (px < lo || py < lo || px > hi || py > hi) continue;
          // Clamp into the straight-edge region; what is left is the corner arc.
          const cx = Math.min(Math.max(px, lo + radius), hi - radius);
          const cy = Math.min(Math.max(py, lo + radius), hi - radius);
          if (Math.hypot(px - cx, py - cy) <= radius) hits++;
        }
      }
      m[y * size + x] = hits / (ss * ss);
    }
  }
  return m;
}

/** The wordmark (or mark) as a crisp mask: an integer scale keeps pixel art sharp. */
function glyphMask(size, useWordmark) {
  const g = useWordmark ? textMask("GNOSIS") : markMask();
  const scale = Math.max(1, Math.floor(Math.min((size * 0.74) / g.w, (size * 0.55) / g.h)));
  const w = g.w * scale;
  const h = g.h * scale;
  const ox = Math.round((size - w) / 2);
  const oy = Math.round((size - h) / 2);
  const m = new Float32Array(size * size);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!g.at(Math.floor(x / scale), Math.floor(y / scale))) continue;
      const px = ox + x;
      const py = oy + y;
      if (px >= 0 && py >= 0 && px < size && py < size) m[py * size + px] = 1;
    }
  }
  return m;
}

/** Separable box blur, run twice — cheap, and smooth enough for a soft shadow. */
function blur(mask, size, radius) {
  const r = Math.round(radius);
  if (r < 1) return mask;
  let src = mask;
  for (let pass = 0; pass < 2; pass++) {
    const tmp = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let sum = 0;
        let n = 0;
        for (let k = -r; k <= r; k++) {
          const xx = x + k;
          if (xx >= 0 && xx < size) { sum += src[y * size + xx]; n++; }
        }
        tmp[y * size + x] = sum / n;
      }
    }
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let sum = 0;
        let n = 0;
        for (let k = -r; k <= r; k++) {
          const yy = y + k;
          if (yy >= 0 && yy < size) { sum += tmp[yy * size + x]; n++; }
        }
        out[y * size + x] = sum / n;
      }
    }
    src = out;
  }
  return src;
}

/** Offset a mask downward — a shadow cast by light from above. */
function offsetY(mask, size, dy) {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= size) continue;
    out.set(mask.subarray(sy * size, sy * size + size), y * size);
  }
  return out;
}

function render(size) {
  const tile = roundedRectMask(size, size * 0.22, size * 0.02);
  const glyph = glyphMask(size, size >= 128);
  // Soft drop shadow beneath the letters. Multiplied by (1 - glyph) so it shows
  // only where the letters are not, and clipped by the tile alpha below so it
  // cannot bleed past the rounded edge.
  const shadow = blur(offsetY(glyph, size, Math.max(1, Math.round(size * 0.023))), size, Math.max(1, size * 0.018));

  const out = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const maxD = Math.hypot(c, c);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const tileA = tile[i];
      if (tileA <= 0) continue;

      // Radial gradient, centre to edges.
      const t = Math.min(1, Math.hypot(x - c, y - c) / maxD);
      let r = CYAN[0] + (MAGENTA[0] - CYAN[0]) * t;
      let g = CYAN[1] + (MAGENTA[1] - CYAN[1]) * t;
      let b = CYAN[2] + (MAGENTA[2] - CYAN[2]) * t;

      const sA = Math.min(1, shadow[i] * 0.55) * (1 - glyph[i]);
      r = r * (1 - sA) + 12 * sA;
      g = g * (1 - sA) + 10 * sA;
      b = b * (1 - sA) + 24 * sA;

      const gA = glyph[i];
      r = r * (1 - gA) + INK[0] * gA;
      g = g * (1 - gA) + INK[1] * gA;
      b = b * (1 - gA) + INK[2] * gA;

      const o = i * 4;
      out[o] = Math.round(r);
      out[o + 1] = Math.round(g);
      out[o + 2] = Math.round(b);
      out[o + 3] = Math.round(255 * tileA);
    }
  }
  return out;
}

// ---------------------------------------------------------------------- output
function buildIco(entries) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const rows = [];
  for (const { size, png } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 0 means 256
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    rows.push(e);
    offset += png.length;
  }
  return Buffer.concat([dir, ...rows, ...entries.map((e) => e.png)]);
}

/** The same masks as flat row strings, for consumers that draw them as DOM/SVG
 * rather than pixels — the web UI's top-bar logo. Generated rather than
 * hand-copied so the browser mark and the taskbar icon cannot drift apart. */
function rowsOf(mask) {
  const rows = [];
  for (let y = 0; y < mask.h; y++) {
    let r = "";
    for (let x = 0; x < mask.w; x++) r += mask.at(x, y) ? "#" : ".";
    rows.push(r);
  }
  return rows;
}

const entries = SIZES.map((size) => ({ size, png: encodePng(size, render(size)) }));
const dir = path.join(root, "electron");
await fs.mkdir(dir, { recursive: true });
await fs.writeFile(path.join(dir, "icon.ico"), buildIco(entries));
await fs.writeFile(path.join(dir, "icon.png"), entries[0].png);
const generated = `// GENERATED by scripts/gen-icon.mjs from electron/wordmark.js — do not edit.
// The pixel rows of the Gnosis mark, so the browser UI draws the same artwork as
// the Windows icon and the tray. Regenerate with: npm run gen:icon
export const MARK_ROWS: readonly string[] = ${JSON.stringify(rowsOf(markMask()), null, 2)};
export const WORDMARK_ROWS: readonly string[] = ${JSON.stringify(rowsOf(textMask("GNOSIS")), null, 2)};
`;
await fs.writeFile(path.join(root, "web", "src", "logo.generated.ts"), generated);
console.log(`gen-icon: electron/icon.ico + icon.png (${SIZES.join(", ")}px) + web/src/logo.generated.ts`);

// Tray icons, drawn in code rather than shipped as image files.
//
// The tray shows the same "G" mark as the app icon (electron/wordmark.js), tinted
// by state. It is deliberately NOT the full gradient icon: a tray icon has to say
// idle / working / listening at 16px, and a fixed gradient tile cannot. The mark
// keeps the identity, the tint carries the status.
//
// nativeImage.createFromBitmap takes raw BGRA, so this is a few lines of
// arithmetic — no image files to keep in sync with the palette.

import { nativeImage } from "electron";
import { markMask } from "./wordmark.js";

const SIZE = 32;

/** Palette shared with the web UI (web/src/styles.css): dim / cyan / magenta. */
export const STATE_COLORS = {
  idle: [0x8b, 0x93, 0xa3],
  active: [0x22, 0xd3, 0xee],
  listening: [0xe8, 0x79, 0xf9],
};

/** A tray image for one state. BGRA, premultiplied — Chromium's bitmaps are. */
export function trayIcon(state) {
  const [r, g, b] = STATE_COLORS[state] ?? STATE_COLORS.idle;
  const mark = markMask();
  // Integer scale only: a fractional one would blur pixel art into mush.
  const scale = Math.max(1, Math.floor(Math.min((SIZE * 0.82) / mark.w, (SIZE * 0.82) / mark.h)));
  const w = mark.w * scale;
  const h = mark.h * scale;
  const ox = Math.round((SIZE - w) / 2);
  const oy = Math.round((SIZE - h) / 2);

  const buf = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mark.at(Math.floor(x / scale), Math.floor(y / scale))) continue;
      const px = ox + x;
      const py = oy + y;
      if (px < 0 || py < 0 || px >= SIZE || py >= SIZE) continue;
      const i = (py * SIZE + px) * 4;
      buf[i] = b;
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: SIZE, height: SIZE });
}

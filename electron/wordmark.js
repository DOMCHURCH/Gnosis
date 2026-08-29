// The GNOSIS pixel-art wordmark and the "G" mark, as pixel grids.
//
// Pure data + a software rasteriser, shared by the app icon (scripts/gen-icon.mjs)
// and the tray (electron/tray-icon.js) so the mark can never drift between the
// taskbar and the notification area. No Electron, no fs — testable on its own.

/** 5×7 pixel font, only the glyphs "GNOSIS" needs. */
const GLYPHS = {
  G: [".###.", "#...#", "#....", "#.##.", "#...#", "#...#", ".###."],
  N: ["#...#", "##..#", "##..#", "#.#.#", "#..##", "#..##", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
};

export const GLYPH_W = 5;
export const GLYPH_H = 7;

/** A word as a {w,h,at(x,y)} pixel mask. One blank column between letters. */
export function textMask(word) {
  const chars = [...word].map((c) => GLYPHS[c]);
  if (chars.some((c) => !c)) throw new Error(`wordmark: no glyph for ${word}`);
  const w = chars.length * GLYPH_W + (chars.length - 1);
  const h = GLYPH_H;
  return {
    w,
    h,
    at(x, y) {
      if (x < 0 || y < 0 || x >= w || y >= h) return false;
      const slot = Math.floor(x / (GLYPH_W + 1));
      const col = x - slot * (GLYPH_W + 1);
      if (col >= GLYPH_W) return false; // the gap between letters
      return chars[slot][y][col] === "#";
    },
  };
}

/** The compact mark used where the full wordmark cannot be read: a single G. */
export function markMask() {
  return textMask("G");
}

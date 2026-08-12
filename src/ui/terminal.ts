// Terminal capability detection and glyph substitution.

export interface Glyphs {
  diamond: string;
  chevron: string;
  barFull: string;
  barEmpty: string;
  dot: string;
  tl: string;
  tr: string;
  bl: string;
  br: string;
  v: string;
  h: string;
  mid: string;
}

const UNICODE: Glyphs = {
  diamond: "◆",
  chevron: "❯",
  barFull: "▓",
  barEmpty: "░",
  dot: "●",
  tl: "╭",
  tr: "╮",
  bl: "╰",
  br: "╯",
  v: "│",
  h: "─",
  mid: "·",
};

const ASCII: Glyphs = {
  diamond: "*",
  chevron: ">",
  barFull: "#",
  barEmpty: "-",
  dot: "*",
  tl: "+",
  tr: "+",
  bl: "+",
  br: "+",
  v: "|",
  h: "-",
  mid: "-",
};

export interface Caps {
  isTTY: boolean;
  color: boolean;
  legacy: boolean;
  glyphs: Glyphs;
}

export function detectCaps(): Caps {
  const isTTY = !!process.stdout.isTTY;
  // Legacy conhost (no Windows Terminal / no known terminal program) renders box
  // characters as mojibake — fall back to ASCII.
  const legacy = !process.env.WT_SESSION && !process.env.TERM_PROGRAM;
  const color = isTTY && !process.env.NO_COLOR;
  const glyphs = legacy || !isTTY ? ASCII : UNICODE;
  return { isTTY, color, legacy, glyphs };
}

export function termWidth(): number {
  return process.stdout.columns || 80;
}

// The "thinking" line shown while a turn is in flight. This is a decorative
// spinner over ANY model — a random playful past-tense verb plus a live elapsed
// timer. It is NOT reasoning text; when a model exposes no reasoning stream (most
// non-Claude models), this is all that shows — never fabricated reasoning.

export const THINKING_WORDS = [
  "Cogitated", "Baked", "Sautéed", "Brewed", "Simmered", "Percolated", "Whittled",
  "Marinated", "Untangled", "Conjured", "Crunched", "Mustered", "Noodled", "Pondered",
  "Ruminated", "Finagled", "Wrangled", "Tinkered", "Distilled", "Fermented", "Kneaded",
  "Puzzling", "Schemed", "Sculpted", "Forged", "Synthesized", "Incubated", "Composted",
  "Calibrated", "Orchestrated", "Assembled", "Deliberated", "Mulled", "Hatched",
  "Concocted", "Devised", "Extrapolated", "Germinated", "Reticulated", "Spelunked",
  "Bamboozled", "Caffeinated", "Galvanized", "Hypothesized", "Improvised", "Juggled",
  "Levitated", "Meandered", "Contemplated", "Steeped", "Churned", "Whisked", "Toiled",
  "Puttered", "Manifested", "Ideated", "Tessellated", "Percolating", "Frobnicated",
];

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const ASCII_SPINNER = ["-", "\\", "|", "/"];

/** Pick a word from the pool given a 0..1 random value (kept pure for testing). */
export function pickWord(rand: number): string {
  const i = Math.min(THINKING_WORDS.length - 1, Math.floor(rand * THINKING_WORDS.length));
  return THINKING_WORDS[i]!;
}

/** Elapsed seconds → "Xm Ys" (or "Ys" under a minute). */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

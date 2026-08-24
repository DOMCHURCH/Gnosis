// Intent-based routing for Obsidian auto-save. Given an assistant response (+ a
// code-fence flag) and the user's message, decide whether it's worth keeping and
// which folder it belongs in. Pure so the browser and the Node verify share it.
//
//   code response (─── fence)                        → Code/
//   decision/plan (approach, decided, because, ...)  → Decisions/
//   research/explanation (> 300 words, no code)      → Research/
//   short answers / status / single sentences        → never save
//   any turn whose user message was under 10 words   → never save

const DECISION_WORDS = ["approach", "decided", "instead", "tradeoff", "because", "reason"];
const RESEARCH_MIN_WORDS = 300;
const TRIVIAL_MAX_WORDS = 25; // a short answer / single sentence, when there's no code

function wordCount(s) {
  return (s || "").trim().split(/\s+/).filter(Boolean).length;
}

/**
 * @param {{ text: string, hasCode: boolean, userMessage: string }} input
 * @returns {{ save: boolean, folder?: string, reason?: string }}
 */
export function classifyNote(input) {
  const text = (input.text || "").trim();
  if (!text) return { save: false, reason: "empty" };
  // Never save a turn the user barely prompted.
  if (wordCount(input.userMessage) < 10) return { save: false, reason: "short user message" };

  const words = wordCount(text);
  // A code response always goes to Code/, regardless of length.
  if (input.hasCode) return { save: true, folder: "Code" };

  // Short prose (single sentence / status) is never worth saving.
  if (words < TRIVIAL_MAX_WORDS) return { save: false, reason: "short answer" };

  const low = text.toLowerCase();
  if (DECISION_WORDS.some((w) => low.includes(w))) return { save: true, folder: "Decisions" };
  if (words > RESEARCH_MIN_WORDS) return { save: true, folder: "Research" };
  return { save: false, reason: "no matching intent" };
}

/** Slug for a note filename from the first meaningful line of the response. */
export function noteSlug(text) {
  const first = ((text || "").split("\n").find((l) => l.trim()) ?? "response").replace(/[`#*_>[\]-]/g, " ").trim();
  return (first.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "response").toLowerCase();
}

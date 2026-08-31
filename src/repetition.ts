// A circuit breaker for degenerate model output.
//
// A model can fall into a repetition attractor mid-completion and stream the
// same sentence until something stops it. Observed in the wild on a voice turn:
// "I'll click the search box." emitted roughly 150 times in one assistant
// message, with no tool calls between them, until the user hit stop. Nothing in
// the engine noticed, because every existing limit counts the wrong thing — the
// iteration cap counts tool rounds (this was one round), the token budget counts
// a whole session (a repeated short line is cheap per copy), and the context
// compactor only runs between iterations.
//
// So the loop was bounded only by the model's own max_tokens and the user's
// patience, and the transcript it produced then went into history, where it is
// both useless and actively harmful: a few hundred identical lines are the
// strongest possible prior that the next line should be the same again.
//
// This watches finalized lines as they stream and trips when the same line comes
// back too many times. It is deliberately about REPETITION, not similarity —
// no fuzzy matching, no embedding — because the failure being caught is exact
// looping, and anything cleverer risks cutting off a model that is legitimately
// working through a list.
//
// Two windows, because degenerate output has two shapes:
//   - immediate:  A A A A A            (consecutive identical lines)
//   - cyclic:     A B A B A B          (a short cycle, no two adjacent equal)

/** Lines shorter than this are ignored — "}" or "." repeat legitimately. */
const MIN_LEN = 12;
/** How many recent lines to keep for cycle detection. */
const WINDOW = 40;

export interface RepetitionVerdict {
  /** True once the guard has decided the stream is degenerate. */
  tripped: boolean;
  /** Human-readable cause, for the system line shown to the user. */
  reason?: string;
  /** The line that was repeating, trimmed for display. */
  line?: string;
}

export class RepetitionGuard {
  private last: string | null = null;
  private streak = 1;
  private recent: string[] = [];
  private verdict: RepetitionVerdict = { tripped: false };

  /**
   * @param consecutive  identical lines in a row before tripping
   * @param cyclic       total occurrences of one line inside the window before tripping
   */
  constructor(
    private readonly consecutive = 6,
    private readonly cyclic = 12,
  ) {}

  get tripped(): boolean {
    return this.verdict.tripped;
  }
  get result(): RepetitionVerdict {
    return this.verdict;
  }

  /** Feed one finalized line. Returns true once the guard has tripped. */
  push(raw: string): boolean {
    if (this.verdict.tripped) return true;
    const line = raw.trim();
    // Short and empty lines are noise here: blank separators, a lone brace, a
    // bullet marker. Counting them would fire on ordinary formatted output.
    if (line.length < MIN_LEN) return false;

    // --- immediate repetition ---
    if (line === this.last) {
      this.streak++;
      if (this.streak >= this.consecutive) {
        return this.trip(`the same line ${this.streak} times in a row`, line);
      }
    } else {
      this.last = line;
      this.streak = 1;
    }

    // --- short-cycle repetition (A B A B ...) ---
    this.recent.push(line);
    if (this.recent.length > WINDOW) this.recent.shift();
    let count = 0;
    for (const r of this.recent) if (r === line) count++;
    if (count >= this.cyclic) {
      return this.trip(`the same line ${count} times in the last ${this.recent.length}`, line);
    }
    return false;
  }

  private trip(reason: string, line: string): boolean {
    this.verdict = { tripped: true, reason, line: line.length > 80 ? `${line.slice(0, 80)}…` : line };
    return true;
  }
}

/**
 * Collapse a degenerate run before it is stored in history.
 *
 * The point is not tidiness. Several hundred identical lines left in the
 * transcript are the strongest possible prior that the NEXT line should be the
 * same again, so storing them verbatim makes the model likelier to do it a
 * second time on the following turn — the guard would then fire every turn while
 * the conversation was, in effect, poisoned. One copy plus a count keeps the
 * fact of what happened without keeping the pattern.
 */
export function collapseRepeats(text: string, threshold = 3): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    let n = 1;
    while (i + n < lines.length && lines[i + n] === line) n++;
    out.push(line);
    if (n >= threshold && line.trim().length >= MIN_LEN) {
      out.push(`[… the same line repeated ${n} times — collapsed]`);
    } else {
      for (let k = 1; k < n; k++) out.push(line);
    }
    i += n;
  }
  return out.join("\n");
}

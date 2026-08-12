// Markdown -> plain-text post-processor for model output.
//
// A hard guarantee applied to the text the user actually sees, independent of the
// model or any system-prompt hint: whatever markdown a model emits, the TUI and
// headless stdout render it flattened to dom's plain style.
//
// The stripper is line-oriented and streaming-safe. `push()` returns whole lines
// as they finalize (each already processed) plus the current incomplete line for
// a transient display; the finished lines are what get committed to the
// transcript. A construct is only processed once its line is complete, so a line
// never commits half-stripped.
//
// Fenced code is sacred for a coding agent: between fences, ALL rules are
// suspended — backticks, asterisks and underscores there are code, not markup —
// and the code passes through byte-for-byte. The opening/closing ``` lines become
// a dim rule (rendered by the UI), keeping the visual boundary without indenting.
//
// Only assistant *text* flows through here. Tool-call JSON is accumulated on a
// separate channel in the provider and never passes through this module.

const HR = /^(?:-{3,}|\*{3,}|={3,})$/;
const FENCE = /^`{3,}/;
const HEADER = /^#{1,6}[ \t]+/;
const BULLET = /^([ \t]*)[-*][ \t]+/;

/** A finalized transcript line. `rule` is a fenced-code boundary (dim, optional
 * language tag); `text` is everything else, already stripped. */
export type StreamLine =
  | { kind: "text"; text: string }
  | { kind: "rule"; lang: string };

/** Strip inline markdown within a single, already block-processed line. */
function stripInline(s: string): string {
  // Inline code: `code` -> code
  s = s.replace(/`([^`]+)`/g, "$1");
  // Links: [text](url) -> text (url)
  s = s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1 ($2)");
  // Bold: **text** -> text  and  __text__ -> text
  s = s.replace(/\*\*(\S(?:.*?\S)?)\*\*/g, "$1");
  s = s.replace(/(?<![A-Za-z0-9])__(\S(?:.*?\S)?)__(?![A-Za-z0-9])/g, "$1");
  // Italic: *text* -> text
  s = s.replace(/\*(\S(?:.*?\S)?)\*/g, "$1");
  // Italic: _text_ -> text, but never intra-word, so snake_case survives intact.
  s = s.replace(/(?<![A-Za-z0-9])_(\S(?:.*?\S)?)_(?![A-Za-z0-9])/g, "$1");
  return s;
}

export class MarkdownStripper {
  private buf = "";
  private inFence = false;

  /**
   * Feed a streamed chunk. Returns the lines that finalized in this chunk (commit
   * these to the transcript, in order) and `pending` — the current incomplete
   * line, for the transient live region. `pending` is the raw in-progress line;
   * it's replaced by its finalized form the moment its newline arrives.
   */
  push(chunk: string): { lines: StreamLine[]; pending: string } {
    this.buf += chunk;
    const lines: StreamLine[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const raw = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const line = this.processLine(raw);
      if (line) lines.push(line);
    }
    return { lines, pending: this.buf };
  }

  /** Finalize the trailing partial line at end of stream (null if nothing left). */
  flush(): StreamLine | null {
    if (this.buf.length === 0) return null;
    const raw = this.buf;
    this.buf = "";
    return this.processLine(raw);
  }

  /** Process one line (no trailing newline). null => drop the whole line (HR). */
  private processLine(line: string): StreamLine | null {
    const trimmed = line.trim();

    // Fence markers become a dim rule and toggle fence state. The language tag on
    // an opening fence is kept; a closing fence carries none.
    if (FENCE.test(trimmed)) {
      if (!this.inFence) {
        this.inFence = true;
        return { kind: "rule", lang: trimmed.replace(/^`+/, "").trim() };
      }
      this.inFence = false;
      return { kind: "rule", lang: "" };
    }

    // Inside a fence: code passes through UNMODIFIED — no indent, no inline
    // stripping. Backticks/asterisks/underscores here are code, not markup.
    if (this.inFence) return { kind: "text", text: line };

    // Horizontal rules (--- / *** / ===): remove the line entirely.
    if (HR.test(trimmed)) return null;

    // ATX headers: drop the leading #'s, keep the text.
    let body = line.replace(HEADER, "");
    // Bullets: leading "* "/"- " -> "· " (indent preserved). Numbered lists (1.)
    // don't match, so they pass through untouched.
    body = body.replace(BULLET, "$1· ");

    return { kind: "text", text: stripInline(body) };
  }
}

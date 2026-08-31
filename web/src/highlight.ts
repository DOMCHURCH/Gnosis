// Syntax highlighting, in one place.
//
// This existed three times — in DiffView, FileOutput and StreamDiff — with the
// same body and three DIFFERENT failure behaviours. Two escaped the text and
// one returned the empty string, which meant a highlighter that threw silently
// emptied the pane and the user saw a file they had opened as blank, with no
// error to explain it. Three copies of a function are a maintenance smell;
// three copies that disagree about what to do when it fails is a bug that only
// shows up in one of them.
//
// Every result here is injected with dangerouslySetInnerHTML, so escaping is
// not cosmetic — it is the only thing standing between a file's contents and
// the DOM. hljs escapes its own output; the fallback has to as well, and that
// is precisely what having one copy guarantees.
import hljs from "highlight.js/lib/common";

/** HTML-escape. The minimum that makes arbitrary text safe as innerHTML. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Highlight `text` as `lang`, falling back to auto-detection, then to escaped
 * plain text.
 *
 * Never returns "" for non-empty input: showing the content unhighlighted is
 * always better than showing nothing, because "nothing" is indistinguishable
 * from an empty file.
 */
export function hl(text: string, lang?: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(text, { language: lang }).value;
    return hljs.highlightAuto(text).value;
  } catch {
    return escapeHtml(text);
  }
}

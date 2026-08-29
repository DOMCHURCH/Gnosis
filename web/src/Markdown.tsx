import { useEffect, useMemo } from "react";
import MarkdownIt from "markdown-it";
import type { StateInline } from "markdown-it";
import DOMPurify from "dompurify";

type MarkdownItInstance = ReturnType<typeof MarkdownIt>;

// Renders note markdown to sanitized HTML. Obsidian [[wikilinks]] become <a> tags
// carrying data-wikilink="<target>"; clicking one calls onWikilink(target) instead
// of navigating, so the reader can open the linked note in place.

const MONO = "'JetBrains Mono', ui-monospace, monospace";

/** markdown-it inline rule: [[Target]] or [[Target|Alias]] → a.wikilink. */
function wikilinkPlugin(md: MarkdownItInstance): void {
  md.inline.ruler.before("link", "wikilink", (state: StateInline, silent: boolean): boolean => {
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false; // "[["
    const end = src.indexOf("]]", start + 2);
    if (end < 0) return false;
    const inner = src.slice(start + 2, end);
    if (!inner || inner.includes("[") || inner.includes("]")) return false;
    if (!silent) {
      const bar = inner.indexOf("|");
      const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
      const alias = (bar >= 0 ? inner.slice(bar + 1) : inner).trim() || target;
      const open = state.push("wikilink_open", "a", 1);
      open.attrSet("class", "wikilink");
      open.attrSet("data-wikilink", target);
      open.attrSet("href", "#");
      const text = state.push("text", "", 0);
      text.content = alias;
      state.push("wikilink_close", "a", -1);
    }
    state.pos = end + 2;
    return true;
  });
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
md.use(wikilinkPlugin);

const STYLE_ID = "dom-md-style";
const CSS = `
.md-body { font-family: ${MONO}; font-size: 12px; line-height: 1.65; color: #C9C9D6; word-wrap: break-word; }
.md-body h1,.md-body h2,.md-body h3,.md-body h4 { color: #E6E6EF; line-height: 1.3; margin: 1.1em 0 0.5em; }
.md-body h1 { font-size: 18px; border-bottom: 1px solid #2C2C3E; padding-bottom: 6px; }
.md-body h2 { font-size: 16px; } .md-body h3 { font-size: 14px; } .md-body h4 { font-size: 13px; }
.md-body p { margin: 0.6em 0; }
.md-body a { color: #22D3EE; text-decoration: none; } .md-body a:hover { text-decoration: underline; }
.md-body a.wikilink { color: #A78BFA; background: rgba(167,139,250,0.10); padding: 0 3px; border-radius: 3px; }
.md-body a.wikilink:hover { background: rgba(167,139,250,0.22); text-decoration: none; }
.md-body code { font-family: ${MONO}; background: #1B1B24; border: 1px solid #2C2C3E; border-radius: 3px; padding: 1px 4px; font-size: 11px; }
.md-body pre { background: #121219; border: 1px solid #2C2C3E; border-radius: 4px; padding: 10px 12px; overflow-x: auto; }
.md-body pre code { background: none; border: 0; padding: 0; }
.md-body ul,.md-body ol { margin: 0.5em 0; padding-left: 1.4em; }
.md-body li { margin: 0.2em 0; }
.md-body blockquote { margin: 0.6em 0; padding: 2px 12px; border-left: 3px solid #2C2C3E; color: #8A8A9B; }
.md-body table { border-collapse: collapse; margin: 0.6em 0; }
.md-body th,.md-body td { border: 1px solid #2C2C3E; padding: 4px 8px; }
.md-body hr { border: 0; border-top: 1px solid #2C2C3E; margin: 1em 0; }
.md-body img { max-width: 100%; }
`;

function ensureStyle(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

export function Markdown(props: { text: string; onWikilink?: (target: string) => void }) {
  useEffect(ensureStyle, []);
  const html = useMemo(
    () => DOMPurify.sanitize(md.render(props.text ?? ""), { ADD_ATTR: ["data-wikilink", "target", "class"] }),
    [props.text],
  );

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a[data-wikilink]") as HTMLElement | null;
    if (!a) return;
    e.preventDefault();
    const target = a.getAttribute("data-wikilink");
    if (target && props.onWikilink) props.onWikilink(target);
  };

  return <div className="md-body" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

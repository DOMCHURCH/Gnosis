// Screen capture, lent to the engine.
//
// The agent used to be told to "take a screenshot with the computer tool" — an
// MCP server that grabs the FOREGROUND window. Asked out loud, the foreground
// window is Gnosis: the voice overlay is on top and the app window is behind it,
// so the answer was always a description of Gnosis looking at itself. Whatever
// the user was actually looking at is behind that.
//
// So: capture the whole display by default. It is the one target that always
// contains what the user meant, and it needs no guessing about which window they
// had in mind. A specific window can still be named, and Gnosis's own windows are
// excluded from that search — asking for a screenshot of Gnosis is the one thing
// nobody does out loud.

import { desktopCapturer, screen as electronScreen } from "electron";

/** Big enough to read UI text in, small enough not to blow up the prompt. */
const MAX_WIDTH = 1600;

/** Windows belonging to this app, which are never the answer. */
const OURS = /^(gnosis|gnosis — settings|gnosis voice)$/i;

export function registerScreen() {
  return {
    /**
     * Capture the screen, or a named window.
     * @param {{ window?: string }} opts
     */
    async capture(opts = {}) {
      const want = String(opts.window ?? "").trim();
      try {
        const display = electronScreen.getPrimaryDisplay();
        const { width, height } = display.size;
        const scale = Math.min(1, MAX_WIDTH / width);
        const thumbnailSize = { width: Math.round(width * scale), height: Math.round(height * scale) };

        const types = want ? ["window", "screen"] : ["screen"];
        const sources = await desktopCapturer.getSources({ types, thumbnailSize, fetchWindowIcons: false });
        if (!sources.length) return { ok: false, error: "no capturable screen was found" };

        let source;
        if (want) {
          const q = want.toLowerCase();
          source = sources.find((s) => !OURS.test(s.name.trim()) && s.name.toLowerCase().includes(q));
          if (!source) {
            const names = sources.filter((s) => !OURS.test(s.name.trim())).map((s) => s.name).slice(0, 12);
            return { ok: false, error: `no window matching "${want}". Open windows: ${names.join(", ") || "none"}` };
          }
        } else {
          source = sources[0];
        }

        const img = source.thumbnail;
        if (!img || img.isEmpty()) return { ok: false, error: "the capture came back empty" };
        const size = img.getSize();
        // JPEG: a full-desktop PNG is several megabytes of base64, and every byte
        // of that is prompt tokens for a picture of a screen.
        const buf = img.toJPEG(80);
        return {
          ok: true,
          frame: {
            mime: "image/jpeg",
            data: buf.toString("base64"),
            width: size.width,
            height: size.height,
            device: source.name,
          },
        };
      } catch (e) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    },
  };
}

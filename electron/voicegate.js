// Which replies get spoken.
//
// The rule is one sentence and the whole feature hangs off it: Gnosis speaks the
// answer to something you SAID, and never the answer to something you typed. A
// coding agent that reads every chat response aloud is a coding agent whose voice
// feature gets switched off within a minute.
//
// It lives here, apart from voice.js, because voice.js cannot be imported outside
// Electron (it reaches for BrowserWindow and ipcMain at module scope) and this is
// exactly the part that has to be tested: "no TTS on a typed message" is a claim
// about behaviour, and a claim about behaviour needs a test that can run.
//
// The gate is armed by the wake-word path only, and disarms itself the instant the
// turn it was armed for ends. Everything else on the bus — other tabs, background
// agents, a turn that was already running when the wake word fired — is ignored,
// because the bus carries every tab and only one of them was spoken to.

/** Prose worth hearing, or "" when the turn produced none.
 *
 * A whole turn read aloud is a minute of speech nobody asked for, so this takes
 * the reply text and caps it at a paragraph, cutting on a word boundary. */
export function speakableReply(lines, limit = 400) {
  const text = lines.join(" ").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit).replace(/\s+\S*$/, "")}…` : text;
}

/**
 * @param {(reply: string) => void} onReply  called once, with the text to speak
 * @param {() => void} onSilent             called instead when the turn said nothing
 */
export function createReplyGate(onReply, onSilent) {
  /** null = nothing spoken to; TTS stays off. */
  let armed = null;

  return {
    /** The wake-word path is handing a turn to `tabId`. Arm BEFORE submitting it:
     * the engine emits its first lines synchronously, and arming afterwards drops
     * the opening of the answer. */
    arm(tabId) {
      armed = { tabId, lines: [] };
    },
    /** Drop the gate without speaking (cancel, error, voice turned off). */
    disarm() {
      armed = null;
    },
    get armed() {
      return armed !== null;
    },
    /** Feed it every bus event. Returns true when this event was consumed. */
    handle(e) {
      if (!armed || !e || e.tabId !== armed.tabId) return false;
      if (e.type === "line") {
        // Assistant prose only. `system` is app chrome, `user` is the echo of what
        // was just said, and `rule` is a code-fence marker — none is a reply.
        const item = e.item;
        if (item && item.kind === "line" && typeof item.text === "string" && item.text.trim()) {
          armed.lines.push(item.text.trim());
        }
        return true;
      }
      if (e.type !== "turn.end") return false;
      const reply = speakableReply(armed.lines);
      // Clear FIRST: speaking is async, and a gate still armed while it runs would
      // collect the next turn's lines into the one it is already reading out.
      armed = null;
      if (reply) onReply(reply);
      else onSilent?.();
      return true;
    },
  };
}

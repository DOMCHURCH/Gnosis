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
 * Split off whatever COMPLETE sentences are at the front of a buffer.
 *
 * Speaking only at turn.end meant the user waited for the entire reply to be
 * generated before hearing a word — on a long answer that is many seconds of
 * silence while the text is already on screen. Sentences are the right unit:
 * small enough to start fast, large enough that synthesis has natural prosody.
 * Anything short (an abbreviation, a decimal) stays in the buffer until more
 * arrives, so "e.g." does not become its own utterance.
 *
 * @returns {{ chunks: string[], rest: string }}
 */
export function takeSentences(buffer, min = 12) {
  const chunks = [];
  let rest = buffer;

  // A terminator alone does not end a sentence — "e.g." and "v1.2" both carry
  // one mid-clause. What distinguishes a real ending is what FOLLOWS it: the end
  // of the text, or whitespace and then something that starts a new sentence.
  // Splitting on the terminator alone chopped "Use a flag, e.g. --force" into two
  // utterances, which is audible and wrong.
  const START_OF_SENTENCE = /["'“‘(\[]?[A-Z0-9]/;

  let from = 0;
  for (;;) {
    const m = rest.slice(from).match(/[.!?…]/);
    if (!m) break;
    const at = from + m.index;
    const cut = at + 1;
    const after = rest.slice(cut);
    const head = rest.slice(0, cut).trim();

    const endsBuffer = after.trim() === "";
    const startsNew = /^\s/.test(after) && START_OF_SENTENCE.test(after.trimStart());

    if (head.length >= min && (endsBuffer || startsNew)) {
      chunks.push(head);
      rest = after.replace(/^\s+/, "");
      from = 0;
      continue;
    }
    from = cut; // not an ending — keep scanning past it
  }
  return { chunks, rest };
}

/**
 * @param {(reply: string) => void} onReply  called once, with the text to speak
 * @param {() => void} onSilent             called instead when the turn said nothing
 * @param {(chunk: string) => void} [onChunk] called per COMPLETE sentence as it
 *        arrives. When provided, the gate streams: onChunk gets each sentence the
 *        moment it finishes and onReply gets only what is left over at the end,
 *        so speech starts while the model is still writing.
 */
export function createReplyGate(onReply, onSilent, onChunk) {
  /** null = nothing spoken to; TTS stays off. */
  let armed = null;

  return {
    /** The wake-word path is handing a turn to `tabId`. Arm BEFORE submitting it:
     * the engine emits its first lines synchronously, and arming afterwards drops
     * the opening of the answer. */
    arm(tabId) {
      armed = { tabId, lines: [], buffer: "", spoke: false };
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
          if (onChunk) {
            // Stream: hand over each sentence as soon as it is complete, so the
            // first words are being spoken while the rest is still generating.
            armed.buffer = `${armed.buffer} ${item.text.trim()}`.trim();
            const { chunks, rest } = takeSentences(armed.buffer);
            armed.buffer = rest;
            for (const c of chunks) { armed.spoke = true; onChunk(c); }
          }
        }
        return true;
      }
      if (e.type !== "turn.end") return false;
      // Whatever is left: the tail of the reply that never got a terminator, or —
      // when not streaming — the whole thing.
      const leftover = onChunk ? armed.buffer.trim() : speakableReply(armed.lines);
      const spoke = armed.spoke;
      // Clear FIRST: speaking is async, and a gate still armed while it runs would
      // collect the next turn's lines into the one it is already reading out.
      armed = null;
      if (leftover) onReply(leftover);
      else if (!spoke) onSilent?.();
      else onReply("");  // nothing left to say, but the turn did speak
      return true;
    },
  };
}

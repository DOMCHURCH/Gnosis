import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { C } from "./theme.js";
import { modeHint } from "./modes.js";
import type { Caps } from "./terminal.js";
import type { Mode } from "../config.js";

interface Props {
  caps: Caps;
  width: number;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  mode: Mode;
  autoApproveEdits: boolean;
  /** A turn is running: the field stays live so a follow-up can be typed, but
   * Enter queues it instead of sending, so the hint reflects that. */
  busy?: boolean;
  /** Ctrl+V was pressed. Fires before the text field handles the same keypress,
   * so the paste can be folded in by onChange (see PasteKey). */
  onPasteKey: () => void;
}

const PLACEHOLDER = "message · /command · !shell · @file";

/**
 * Notices Ctrl+V one step ahead of the text field.
 *
 * Ink delivers a keypress to its listeners in the order they subscribed, and
 * effects run children-first — so this renders BEFORE <TextInput> precisely so its
 * listener is registered first and runs first. That ordering is the whole point:
 * ink-text-input reads Ctrl+V as the plain letter "v" and inserts one, and Ink
 * commits that render before the next listener runs, so anything downstream can no
 * longer tell the stray character apart from a typed one. Flagging the paste here
 * lets onChange fix it up while it still knows what the value was a moment ago.
 *
 * Renders nothing.
 */
function PasteKey({ onPaste }: { onPaste: () => void }) {
  useInput((inp, key) => {
    if (key.ctrl && inp === "v") onPaste();
  });
  return null;
}

// Single-line compose field: a chevron prefix + TextInput, no border box — the
// same one-line, prefix-led shape the tool calls use, to save vertical space.
// The hint line renders while the input is empty (or the whole time a turn runs,
// where every keystroke is a queued follow-up), so a line of typing doesn't drag
// a hint under it.
export function InputBar({ caps, width, value, onChange, onSubmit, mode, autoApproveEdits, busy, onPasteKey }: Props) {
  const g = caps.glyphs;
  const col = (hex: string) => (caps.color ? hex : undefined);

  return (
    <Box flexDirection="column" width={width}>
      <Box width={width}>
        <Text color={col(C.chevron)}>{g.chevron} </Text>
        <PasteKey onPaste={onPasteKey} />
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder={busy ? "type to queue a follow-up…" : PLACEHOLDER}
        />
      </Box>
      {busy ? (
        <Text color={col(C.dim)} wrap="truncate">
          enter queues this message · esc clears the queue
        </Text>
      ) : value === "" ? (
        <Text color={col(C.dim)} wrap="truncate">
          {modeHint(mode, autoApproveEdits)}
        </Text>
      ) : null}
    </Box>
  );
}

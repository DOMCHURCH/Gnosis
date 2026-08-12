import { Box, Text } from "ink";
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
}

const PLACEHOLDER = "message · /command · !shell · @file";

// Claude-Code-style compose field: a rounded frame (same C.frame border as the
// banner) with the chevron and TextInput inside, and the mode hint on a dim line
// below it. Purely presentational — every handler is passed straight through, so
// Enter still submits, @file/!shell/commands and shift+tab behave identically.
export function InputBar({ caps, width, value, onChange, onSubmit, mode, autoApproveEdits }: Props) {
  const g = caps.glyphs;
  const col = (hex: string) => (caps.color ? hex : undefined);
  const boxed = caps.isTTY && !caps.legacy;

  // ink-text-input swaps placeholder<->value itself: the grey placeholder shows
  // only while value is empty, so hint text and typed text never render together.
  const field = (
    <TextInput value={value} onChange={onChange} onSubmit={onSubmit} placeholder={PLACEHOLDER} />
  );

  const hint = (
    <Text color={col(C.dim)} wrap="truncate">
      {modeHint(mode, autoApproveEdits)}
    </Text>
  );

  // Legacy conhost / non-TTY renders round-border glyphs as mojibake (same reason
  // the banner drops its frame there), so fall back to the bare chevron prompt.
  if (!boxed) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={col(C.chevron)}>{g.chevron} </Text>
          {field}
        </Box>
        {hint}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={col(C.frame)} paddingX={1} width={width}>
        <Text color={col(C.chevron)}>{g.chevron} </Text>
        {field}
      </Box>
      <Box width={width} justifyContent="space-between">
        {hint}
        <Text color={col(C.dim)} wrap="truncate">
          {g.chevron === ">" ? "enter to send" : "⏎ send"}
        </Text>
      </Box>
    </Box>
  );
}

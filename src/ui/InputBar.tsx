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

// Single-line compose field: a chevron prefix + TextInput, no border box — the
// same one-line, prefix-led shape the tool calls use, to save vertical space.
// The mode hint (which carries the shift+tab-to-cycle affordance) renders only
// while the input is empty, so a line of typing doesn't drag a hint under it.
export function InputBar({ caps, width, value, onChange, onSubmit, mode, autoApproveEdits }: Props) {
  const g = caps.glyphs;
  const col = (hex: string) => (caps.color ? hex : undefined);

  return (
    <Box flexDirection="column" width={width}>
      <Box width={width}>
        <Text color={col(C.chevron)}>{g.chevron} </Text>
        <TextInput value={value} onChange={onChange} onSubmit={onSubmit} placeholder={PLACEHOLDER} />
      </Box>
      {value === "" ? (
        <Text color={col(C.dim)} wrap="truncate">
          {modeHint(mode, autoApproveEdits)}
        </Text>
      ) : null}
    </Box>
  );
}

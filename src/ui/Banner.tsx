import { Box, Text } from "ink";
import { ART, BANNER_ROWS, C, TAGLINE } from "./theme.js";
import type { Caps } from "./terminal.js";

interface Props {
  caps: Caps;
  width: number;
  tools: string[];
  ghAuth: string;
}

export function Banner({ caps, width, tools, ghAuth }: Props) {
  const g = caps.glyphs;
  const col = (hex: string) => (caps.color ? hex : undefined);

  // The active model is intentionally omitted here: the banner lives in <Static>
  // and can't repaint after a mid-session /model switch, so it would go stale.
  // The status bar (which reads live session state) is the single source of truth.

  // <52 cols: flat "DOM".
  if (width < 52) {
    return (
      <Box>
        <Text color={col(C.cyan)} bold>
          DOM
        </Text>
      </Box>
    );
  }

  // Compact 8-row banner: the six art rows + one dim status line. No frame (it
  // cost two rows and the boot screen only shows once) and no separate tagline /
  // tools / gh rows — they fold into the single status line to save vertical space.
  const status = `${TAGLINE} · ${tools.join(" ")} · gh ${ghAuth}`.replaceAll("·", g.mid);
  return (
    <Box flexDirection="column" width={width}>
      {ART.map((line, i) => (
        <Text key={i} color={col(BANNER_ROWS[i]!)}>
          {line}
        </Text>
      ))}
      <Box marginTop={1} width={width}>
        <Text color={col(C.dim)} wrap="truncate">
          {status}
        </Text>
      </Box>
    </Box>
  );
}

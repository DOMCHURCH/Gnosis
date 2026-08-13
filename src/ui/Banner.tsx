import type { ReactNode } from "react";
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

  const Row = ({ label, children }: { label: string; children: ReactNode }) => (
    <Box>
      <Text color={col(C.bullet)}>{g.diamond} </Text>
      <Text color={col(C.label)}>{label.padEnd(6)} </Text>
      {children}
    </Box>
  );

  const body = (
    <Box flexDirection="column">
      {ART.map((line, i) => (
        <Text key={i} color={col(BANNER_ROWS[i]!)}>
          {line}
        </Text>
      ))}
      <Box marginTop={1}>
        <Text color={col(C.dim)}>{TAGLINE.replaceAll("·", g.mid)}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Row label="tools">
          <Text color={col(C.value)}>{tools.join(" ")}</Text>
        </Row>
        <Row label="gh">
          <Text color={col(C.value)}>{ghAuth}</Text>
        </Row>
      </Box>
    </Box>
  );

  // >=76 cols and a capable terminal: draw the frame. 52-75 or legacy: no frame.
  if (width >= 76 && caps.isTTY && !caps.legacy) {
    return (
      <Box borderStyle="round" borderColor={col(C.frame)} paddingX={1} paddingY={0}>
        {body}
      </Box>
    );
  }
  return body;
}

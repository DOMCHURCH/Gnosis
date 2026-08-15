import { Box, Text } from "ink";
import { C } from "./theme.js";
import type { Caps } from "./terminal.js";
import type { TiledLayout, StackedLayout } from "./alltabs.js";

interface Props {
  caps: Caps;
  width: number;
  layout: TiledLayout | StackedLayout;
}

// Read-only tiled (or stacked) overview of every tab. The active tab's cell
// border is highlighted (C.model); background cells use the dim frame color.
export function AllTabs({ caps, width, layout }: Props) {
  const g = caps.glyphs;
  const col = (hex: string) => (caps.color ? hex : undefined);
  const border = (active: boolean) => col(active ? C.model : C.frame);

  if (layout.kind === "stacked") {
    return (
      <Box flexDirection="column" width={width}>
        {layout.items.map((it, i) => (
          <Box key={i} flexDirection="column">
            <Text color={col(it.active ? C.model : C.dim)} wrap="truncate">
              {it.title}
            </Text>
            {it.lines.map((ln, j) => (
              <Text key={j} color={col(C.value)} wrap="truncate">
                {"  " + (ln || " ")}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width}>
      {layout.grid.map((row, ri) => (
        <Box key={ri} flexDirection="row">
          {row.map((cell, ci) => (
            <Box key={ci} flexDirection="column" marginRight={ci < row.length - 1 ? 1 : 0}>
              <Text color={border(cell.active)} wrap="truncate">
                {cell.top}
              </Text>
              {cell.body.map((ln, li) => (
                <Text key={li} wrap="truncate">
                  <Text color={border(cell.active)}>{g.v + " "}</Text>
                  <Text color={col(C.value)}>{ln}</Text>
                  <Text color={border(cell.active)}>{" " + g.v}</Text>
                </Text>
              ))}
              <Text color={border(cell.active)} wrap="truncate">
                {cell.bottom}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

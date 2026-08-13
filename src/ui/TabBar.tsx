import { Box, Text } from "ink";
import { C } from "./theme.js";
import type { Caps } from "./terminal.js";
import type { Badge } from "../tabs.js";

export interface TabInfo {
  name: string;
  active: boolean;
  badge: Badge;
  busy: boolean;
}

interface Props {
  caps: Caps;
  /** Hard width budget (columns - 2): the row is truncated to fit one line. */
  width: number;
  tabs: TabInfo[];
}

// Amber approval dot vs a dim output dot (ASCII fallbacks on legacy terminals).
function badgeGlyph(badge: Badge, legacy: boolean): string {
  if (badge === "approval") return legacy ? "!" : "●";
  if (badge === "output") return legacy ? "*" : "•";
  return "";
}

export function TabBar({ caps, width, tabs }: Props) {
  const col = (hex: string) => (caps.color ? hex : undefined);
  const amber = "#fbbf24";

  // Build segments with an exact width budget so the row never wraps to a second
  // line. When they don't all fit, the overflow collapses to a "+N" marker.
  type Seg = { text: string; color?: string };
  const segs: Seg[] = [];
  let used = 0;
  let dropped = 0;

  tabs.forEach((t, i) => {
    const marker = t.active ? "▍" : " ";
    const badge = t.badge !== "none" && !t.active ? badgeGlyph(t.badge, caps.legacy) : "";
    const label = `${marker}${i + 1}:${t.name}${t.busy ? "…" : ""}${badge}`;
    const piece = (i > 0 ? " " : "") + label;
    if (used + piece.length > width - 4 && i > 0) {
      dropped++;
      return;
    }
    used += piece.length;
    if (i > 0) segs.push({ text: " " });
    segs.push({ text: `${marker}${i + 1}:${t.name}${t.busy ? "…" : ""}`, color: t.active ? C.model : C.dim });
    if (badge) segs.push({ text: badge, color: t.badge === "approval" ? amber : C.cyan });
  });
  if (dropped) segs.push({ text: ` +${dropped}`, color: C.dim });

  return (
    <Box width={width}>
      {segs.map((s, i) => (
        <Text key={i} color={col(s.color ?? C.value)} wrap="truncate">
          {s.text}
        </Text>
      ))}
    </Box>
  );
}

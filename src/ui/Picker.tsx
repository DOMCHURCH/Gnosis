import { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { C } from "./theme.js";
import { fuzzyFilter } from "../fuzzy.js";
import type { Caps } from "./terminal.js";

export interface PickItem {
  value: string;
  label: string;
  hint?: string;
  /** Substring/fuzzy-match target for filtering; falls back to hint when absent. */
  search?: string;
  /** Base ranking (lower = better), used as the fuzzy tiebreaker (e.g. repo-map order). */
  rank?: number;
  /** Model picker only: "free" | "paid" | "unknown". Carried over the wire so the
   * browser overlay can group the catalog into tabs; the TUI ignores it. */
  tier?: string;
}

interface Props {
  caps: Caps;
  /** Border width (columns - 2) so the box never reaches the terminal's edge. */
  width: number;
  title: string;
  items: PickItem[];
  onSelect: (value: string) => void;
  onCancel: () => void;
  /** Row highlighted on open (by value); falls back to the first row. */
  initialValue?: string;
  /** Optional secondary action on Ctrl+S (e.g. "save as default"); shown in the footer. */
  onSave?: (value: string) => void;
  saveHint?: string;
  /** Fuzzy subsequence match + score ranking (repo-map @-completion) instead of the
   * default multi-term substring filter. */
  fuzzy?: boolean;
}

const VISIBLE = 12;

export function Picker({ caps, width, title, items, onSelect, onCancel, initialValue, onSave, saveHint, fuzzy }: Props) {
  const col = (hex: string) => (caps.color ? hex : undefined);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(() => {
    if (!initialValue) return 0;
    const i = items.findIndex((it) => it.value === initialValue);
    return i >= 0 ? i : 0;
  });

  const filtered = useMemo(() => {
    if (fuzzy) return fuzzyFilter(items, query); // subsequence match, ranked; empty query → items
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return items;
    return items.filter((it) => {
      const hay = (it.label + " " + (it.search ?? it.hint ?? "")).toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [items, query, fuzzy]);

  const clampedSel = Math.min(sel, Math.max(0, filtered.length - 1));

  useInput((input, key) => {
    if (key.escape) return onCancel();
    // Ctrl+S: the secondary "save" action on the highlighted row (0x13 = DC3).
    if (onSave && key.ctrl && (input === "s" || input === "")) {
      const chosen = filtered[clampedSel];
      if (chosen) onSave(chosen.value);
      return;
    }
    if (key.return) {
      const chosen = filtered[clampedSel];
      if (chosen) onSelect(chosen.value);
      return;
    }
    if (key.upArrow) return setSel((s) => Math.max(0, Math.min(s, filtered.length - 1) - 1));
    if (key.downArrow) return setSel((s) => Math.min(filtered.length - 1, s + 1));
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setSel(0);
      return;
    }
    if (input && !key.ctrl && !key.meta && input >= " ") {
      setQuery((q) => q + input);
      setSel(0);
    }
  });

  const start = Math.max(0, Math.min(clampedSel - Math.floor(VISIBLE / 2), Math.max(0, filtered.length - VISIBLE)));
  const window = filtered.slice(start, start + VISIBLE);
  const g = caps.glyphs;

  return (
    <Box
      flexDirection="column"
      borderStyle={caps.isTTY && !caps.legacy ? "round" : undefined}
      borderColor={col(C.frame)}
      paddingX={1}
      width={width}
    >
      <Text color={col(C.model)} wrap="truncate">{title}</Text>
      <Box>
        <Text color={col(C.label)}>filter{g.chevron} </Text>
        <Text color={col(C.value)} wrap="truncate-start">{query}</Text>
        <Text color={col(C.dim)}>▌</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {window.length === 0 && <Text color={col(C.dim)}>no matches</Text>}
        {window.map((it, i) => {
          const idx = start + i;
          const active = idx === clampedSel;
          return (
            <Box key={it.value}>
              <Text color={col(active ? C.model : C.dim)}>{active ? `${g.chevron} ` : "  "}</Text>
              <Text color={col(active ? C.value : C.label)} wrap="truncate-end">{it.label}</Text>
              {it.hint && <Text color={col(C.dim)} wrap="truncate-end">  {it.hint}</Text>}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={col(C.dim)} wrap="truncate">
          {filtered.length} match{filtered.length === 1 ? "" : "es"} {g.mid} ↑↓ select {g.mid} enter confirm {g.mid} esc cancel
          {onSave ? ` ${g.mid} ctrl+s ${saveHint ?? "save"}` : ""}
        </Text>
      </Box>
    </Box>
  );
}

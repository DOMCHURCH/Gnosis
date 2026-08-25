import { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { C } from "./theme.js";
import type { Caps } from "./terminal.js";

interface Props {
  caps: Caps;
  /** Border width (columns - 2) so the box never reaches the terminal's edge. */
  width: number;
  question: string;
  options: string[];
  onAnswer: (text: string) => void;
}

/**
 * The `ask_user` prompt: the agent's question, its suggested choices, and a
 * free-text box. Free text is always available — the options are a shortcut, not
 * a cage, because the right answer is often "neither, do X".
 *
 * Escape answers with "" rather than leaving the promise dangling; the tool reads
 * an empty answer as "no steer given" and the turn continues.
 */
export function AskUser({ caps, width, question, options, onAnswer }: Props) {
  const col = (hex: string) => (caps.color ? hex : undefined);
  // Options occupy indices 0..n-1; index n is the free-text row.
  const freeIndex = options.length;
  const [sel, setSel] = useState(0);
  const [draft, setDraft] = useState("");
  const typing = sel === freeIndex;

  useInput((input, key) => {
    if (key.escape) return onAnswer("");
    if (typing) {
      // Let TextInput own printable keys; only navigate off the field on ↑.
      if (key.upArrow && options.length) setSel(options.length - 1);
      return;
    }
    if (key.upArrow) setSel((s) => (s + freeIndex) % (freeIndex + 1));
    else if (key.downArrow || key.tab) setSel((s) => (s + 1) % (freeIndex + 1));
    else if (key.return) onAnswer(options[sel] ?? "");
    else if (/^[1-9]$/.test(input)) {
      const i = Number(input) - 1;
      if (i < options.length) onAnswer(options[i]!);
    }
  });

  return (
    <Box flexDirection="column" borderStyle={caps.isTTY && !caps.legacy ? "round" : undefined} borderColor={col(C.chevron)} paddingX={1} width={width}>
      <Text color={col(C.chevron)} wrap="truncate">
        ? the agent needs a decision
      </Text>
      <Box marginTop={1}>
        <Text color={col(C.value)} wrap="wrap">
          {question}
        </Text>
      </Box>
      {options.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {options.map((o, i) => (
            <Text key={i} color={col(sel === i ? C.cyan : C.label)} wrap="truncate">
              {sel === i ? "❯ " : "  "}
              {i + 1}. {o}
            </Text>
          ))}
        </Box>
      )}
      <Box marginTop={options.length ? 1 : 0}>
        <Text color={col(typing ? C.cyan : C.label)}>{typing ? "❯ " : "  "}</Text>
        {typing ? (
          <TextInput value={draft} onChange={setDraft} onSubmit={(v) => onAnswer(v.trim())} placeholder="type your own answer…" />
        ) : (
          <Text color={col(C.label)} wrap="truncate">
            or type your own answer
          </Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={col(C.dim)} wrap="truncate">
          ↑↓ choose · enter accept · esc skip (the agent decides)
        </Text>
      </Box>
    </Box>
  );
}

import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { C } from "./theme.js";
import type { Caps } from "./terminal.js";
import type { Preview, PermissionAnswer } from "../permissions.js";

interface Props {
  caps: Caps;
  /** Border width (columns - 2) so the box never reaches the terminal's edge. */
  width: number;
  preview: Preview;
  onDecide: (answer: PermissionAnswer) => void;
}

export function Permission({ caps, width, preview, onDecide }: Props) {
  const col = (hex: string) => (caps.color ? hex : undefined);
  const dangerous = preview.dangerous;
  const options: { key: PermissionAnswer; label: string }[] = dangerous
    ? [
        { key: "yes", label: "yes" },
        { key: "no", label: "no" },
      ]
    : [
        { key: "yes", label: "yes" },
        { key: "no", label: "no" },
        { key: "always", label: "always (this session)" },
      ];

  const [sel, setSel] = useState(0);

  useInput((input, key) => {
    if (key.leftArrow || key.upArrow) setSel((s) => (s + options.length - 1) % options.length);
    else if (key.rightArrow || key.downArrow || key.tab) setSel((s) => (s + 1) % options.length);
    else if (key.return) onDecide(options[sel]!.key);
    else if (input === "y") onDecide("yes");
    else if (input === "n" || key.escape) onDecide("no");
    else if (input === "a" && !dangerous) onDecide("always");
  });

  return (
    <Box
      flexDirection="column"
      borderStyle={caps.isTTY && !caps.legacy ? "round" : undefined}
      borderColor={col(dangerous ? C.danger : C.frame)}
      paddingX={1}
      width={width}
    >
      <Text color={col(dangerous ? C.danger : C.bullet)} wrap="truncate">
        {dangerous
          ? "⚠ dangerous — approval required (always prompts, even in yolo/auto-accept)"
          : preview.kind === "diff"
            ? "apply this change?"
            : "permission required"}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {renderPreview(preview, col)}
      </Box>
      <Box marginTop={1}>
        {options.map((o, i) => (
          <Text key={o.key} color={col(i === sel ? C.model : C.dim)}>
            {i === sel ? "▶ " : "  "}
            {o.label}
            {i < options.length - 1 ? "   " : ""}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function renderPreview(preview: Preview, col: (h: string) => string | undefined) {
  if (preview.kind === "http") {
    return (
      <>
        <Text color={col(C.value)} wrap="truncate-end">
          {preview.method} {preview.url}
        </Text>
        {preview.warning && (
          <Text color={col(C.danger)} wrap="truncate-end">
            ⚠ {preview.warning}
          </Text>
        )}
      </>
    );
  }
  if (preview.kind === "bash") {
    return (
      <>
        <Text color={col(C.value)} wrap="truncate-end">
          $ {preview.command}
        </Text>
        <Text color={col(C.dim)} wrap="truncate-start">
          in {preview.cwd}
        </Text>
        {preview.warning && (
          <Text color={col(C.danger)} wrap="truncate-end">
            ⚠ {preview.warning}
          </Text>
        )}
      </>
    );
  }
  // diff — coloured unified diff (jsdiff), truncated by buildDiffPreview.
  const lineColor = (kind: string) =>
    kind === "add" ? C.added : kind === "del" ? C.removed : kind === "hunk" ? C.label : C.dim;
  return (
    <>
      <Text color={col(C.label)} wrap="truncate-start">
        {preview.tool} {preview.absPath}
      </Text>
      {preview.warning && (
        <Text color={col(C.danger)} wrap="truncate-end">
          ⚠ {preview.warning}
        </Text>
      )}
      {preview.lines.map((l, i) => (
        <Text key={i} color={col(lineColor(l.kind))} wrap="truncate-end">
          {l.text}
        </Text>
      ))}
      {preview.moreLines > 0 && <Text color={col(C.dim)}>(+{preview.moreLines} more lines)</Text>}
    </>
  );
}

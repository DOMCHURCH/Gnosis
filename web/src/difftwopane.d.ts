export interface DiffCell {
  num: number | null;
  text: string;
}
export interface DiffRow {
  left: DiffCell | null;
  right: DiffCell | null;
  type: "context" | "del" | "add";
}

/** Parse a unified diff (headers stripped) into aligned two-pane rows. */
export function parseUnifiedDiff(detail: string): DiffRow[];

/** hljs language id guessed from a file path's extension (best-effort). */
export function langFromPath(path: string): string | undefined;

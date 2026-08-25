export type FileKind = "image" | "code" | "json" | "csv" | "pdf" | "generic";
export interface FileOutput {
  path: string;
  kind: FileKind;
  ext: string;
  lang: string;
  name: string;
  /** True when the path was guessed from a shell command and must be confirmed. */
  verify?: boolean;
}
export function extOf(p: string): string;
export function fileKind(p: string): FileKind | null;
export function langOf(p: string): string;
export function candidatePaths(text: string): string[];
export function fileOutputFor(toolName: string, primary: string, output?: string): FileOutput | null;
export function parseCsv(text: string, rows?: number): string[][];

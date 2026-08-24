// qrcode-terminal ships no types. Terminal-only (never in the web bundle).
declare module "qrcode-terminal" {
  export function generate(input: string, opts?: { small?: boolean }, cb?: (output: string) => void): void;
  const _default: { generate: typeof generate };
  export default _default;
}

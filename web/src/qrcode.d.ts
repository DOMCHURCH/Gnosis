declare module "qrcode" {
  interface QrOptions {
    type?: "svg" | "utf8" | "terminal";
    margin?: number;
    width?: number;
    color?: { dark?: string; light?: string };
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  }
  export function toString(text: string, opts?: QrOptions): Promise<string>;
  export function toDataURL(text: string, opts?: QrOptions): Promise<string>;
  const _default: { toString: typeof toString; toDataURL: typeof toDataURL };
  export default _default;
}

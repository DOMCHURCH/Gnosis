// Terminal QR codes for `dom serve` — encodes the full tokenized URL so a phone can
// scan instead of typing it. Uses qrcode-terminal (terminal-only; nothing here ever
// reaches the web bundle). Dynamic import so a missing dep degrades to "" rather
// than crashing serve startup.

export async function qrTerminal(text: string): Promise<string> {
  try {
    const mod = await import("qrcode-terminal");
    const qt = (mod.default ?? mod) as { generate: (t: string, o: { small?: boolean }, cb: (s: string) => void) => void; setErrorLevel?: (l: string) => void };
    if (!qt.generate) return "";
    qt.setErrorLevel?.("L"); // required, else auto-sizing throws "bad rs block"
    return await new Promise<string>((resolve) => qt.generate(text, { small: true }, (out: string) => resolve(out)));
  } catch {
    return "";
  }
}

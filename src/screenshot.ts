// Headless-browser screenshot for design mode. Playwright is imported dynamically
// so a missing dependency (or un-downloaded browser) degrades to a clear message
// rather than crashing the agent — the same pattern as node-pty in pty.ts.

export interface ShotResult {
  ok: boolean;
  /** Base64 PNG bytes (no data: prefix), when ok. */
  data?: string;
  mime?: string;
  error?: string;
}

/** Capture a PNG of `url` in headless Chromium. Best-effort: any failure (missing
 * Playwright, un-launchable browser, unreachable server, timeout) resolves to
 * { ok: false, error } — it never throws. */
export async function captureScreenshot(url: string, timeoutMs = 15000): Promise<ShotResult> {
  let pw: typeof import("playwright") | null = null;
  try {
    pw = await import("playwright");
  } catch {
    return { ok: false, error: "design mode needs Playwright — run: npm i -D playwright && npx playwright install chromium" };
  }
  let browser: import("playwright").Browser | null = null;
  try {
    browser = await pw.chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
    const buf = await page.screenshot({ type: "png", fullPage: false });
    return { ok: true, data: Buffer.from(buf).toString("base64"), mime: "image/png" };
  } catch (e) {
    return { ok: false, error: `screenshot failed for ${url}: ${(e as Error).message}` };
  } finally {
    await browser?.close().catch(() => {});
  }
}

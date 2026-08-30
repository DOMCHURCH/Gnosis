// Screen capture, as a capability the shell lends the engine.
//
// Same shape and same reasoning as src/camera.ts: the engine is Node, the capture
// needs Electron, and the engine must never import from electron/ because the
// same engine runs in a terminal and under `dom serve`. Nothing registers a
// provider there, and the tool says so plainly.

import type { CameraFrame } from "./camera.js";

export type ScreenResult = { ok: true; frame: CameraFrame } | { ok: false; error: string };

export type ScreenProvider = (opts: { window?: string }) => Promise<ScreenResult>;

let provider: ScreenProvider | null = null;

export function setScreenProvider(p: ScreenProvider | null): void {
  provider = p;
}

export function hasScreen(): boolean {
  return provider !== null;
}

/** Capture the display (or a named window). Never throws. */
export async function captureScreen(opts: { window?: string } = {}): Promise<ScreenResult> {
  if (!provider) {
    return {
      ok: false,
      error:
        "No screen capture is available here. It is a desktop-app capability: it needs the Gnosis desktop " +
        "process. There is no screen to capture from the terminal or from `dom serve`.",
    };
  }
  try {
    return await provider(opts);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// Camera capture, as a capability the shell lends the engine.
//
// The engine runs in Node and Node has no camera. getUserMedia needs a renderer,
// and the desktop shell already owns one — the hidden window that holds the
// microphone for the wake word. So the shell registers a provider here at
// startup, and the `camera` tool calls whatever is registered.
//
// The indirection is the point. The engine must not import from electron/: the
// same engine runs under `dom` in a terminal and under `dom serve` on a machine
// with no display, and both have to keep working. Nothing registers a provider
// there, `hasCamera()` is false, and the tool says so plainly instead of failing
// somewhere deep in a stack the user cannot read.

/** A captured still: base64 image bytes and what kind of image they are. */
export interface CameraFrame {
  mime: string;
  /** base64, no data: prefix. */
  data: string;
  width?: number;
  height?: number;
  /** Which device took it, so a virtual camera can be named rather than guessed at. */
  device?: string;
  /** Mean luminance 0..1. Near zero means a covered lens or an unlit room — the
   * frame is valid and shows nothing, which a model cannot tell on its own. */
  luma?: number | null;
}

export type CameraResult = { ok: true; frame: CameraFrame } | { ok: false; error: string };

export type CameraProvider = () => Promise<CameraResult>;

let provider: CameraProvider | null = null;

/** Called by the desktop shell once its capture renderer exists. */
export function setCameraProvider(p: CameraProvider | null): void {
  provider = p;
}

/** Is there a camera to reach at all? False in the CLI and in headless serve. */
export function hasCamera(): boolean {
  return provider !== null;
}

/** Take one frame, or say why not. Never throws. */
export async function captureCamera(): Promise<CameraResult> {
  if (!provider) {
    return {
      ok: false,
      error:
        "No camera is available here. The webcam is a desktop-app capability: it needs the Gnosis desktop " +
        "window, which owns the capture renderer. There is no camera from the terminal or from `dom serve`.",
    };
  }
  try {
    return await provider();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

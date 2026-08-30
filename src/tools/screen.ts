// screen — capture the user's display so a vision model can see it.
//
// Wired like view_image and camera: the tool returns text and the pixels ride to
// the model as an image block on the next message.
//
// It captures the whole DISPLAY by default rather than the foreground window,
// which is the fix for the bug it was written for. Asked out loud, the foreground
// window is Gnosis — the voice overlay is on top — so a foreground capture
// answered every "what's on my screen" with a picture of Gnosis. The display
// always contains what the user meant.

import type { ToolContext, ToolResult } from "./index.js";
import type { ScreenArgs } from "./schemas.js";
import { captureScreen, hasScreen } from "../screen.js";

export async function runScreen(args: ScreenArgs, _signal?: AbortSignal, ctx?: ToolContext): Promise<ToolResult> {
  if (!ctx?.attachImage) {
    return { output: "Refused: there is nothing to attach an image to in this context.", isError: true };
  }
  if (!hasScreen()) {
    return {
      output:
        "No screen capture here. It exists only in the Gnosis desktop app — not in the terminal and not " +
        "over `dom serve`.",
      isError: true,
    };
  }

  const shot = await captureScreen({ window: args?.window });
  if (!shot.ok) return { output: `Screen capture failed: ${shot.error}`, isError: true };

  ctx.attachImage({ source: "screen", mime: shot.frame.mime, data: shot.frame.data });
  const size = Math.round((shot.frame.data.length * 3) / 4 / 1024);
  const what = shot.frame.device ? ` of "${shot.frame.device}"` : "";
  return {
    output:
      `Captured the screen${what} (${shot.frame.width}x${shot.frame.height}, ${size}KB). It is attached to ` +
      `your next message — describe what you actually see on it.`,
    isError: false,
  };
}

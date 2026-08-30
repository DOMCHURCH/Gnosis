// camera — take one frame from the webcam so a vision model can see it.
//
// Wired exactly like view_image: the tool itself returns a text confirmation and
// the actual bytes ride to the model as an image content block on the next
// message (ctx.attachImage). The difference is only where the bytes come from —
// a live capture rather than a file on disk.
//
// It does NOT refuse when the active model has no vision input. That check used
// to live here, and it made the tool useless in the case it is most wanted:
// someone speaks "what do you see", the session is on a fast text model, and the
// honest answer is to switch for that one turn rather than to tell them no. The
// engine does that swap when it flushes the attachment.

import type { ToolContext, ToolResult } from "./index.js";
import type { CameraArgs } from "./schemas.js";
import { captureCamera, hasCamera } from "../camera.js";

export async function runCamera(args: CameraArgs, _signal?: AbortSignal, ctx?: ToolContext): Promise<ToolResult> {
  if (!ctx?.attachImage) {
    return { output: "Refused: there is nothing to attach an image to in this context.", isError: true };
  }
  if (!hasCamera()) {
    return {
      output:
        "No camera here. The webcam only exists in the Gnosis desktop app, which owns the capture window — " +
        "not in the terminal and not over `dom serve`.",
      isError: true,
    };
  }

  const shot = await captureCamera();
  if (!shot.ok) return { output: `Camera capture failed: ${shot.error}`, isError: true };

  ctx.attachImage({ source: "camera", mime: shot.frame.mime, data: shot.frame.data });
  const size = Math.round((shot.frame.data.length * 3) / 4 / 1024);
  const dims = shot.frame.width && shot.frame.height ? `${shot.frame.width}x${shot.frame.height}, ` : "";
  const why = String(args?.reason ?? "").trim();
  // A covered lens or an unlit room yields a perfectly valid frame of nothing,
  // and a model handed one describes a dark room with total confidence. Say so.
  const dark = typeof shot.frame.luma === "number" && shot.frame.luma < 0.02;
  return {
    output:
      `Captured a webcam frame (${dims}${size}KB` +
      (shot.frame.device ? `, ${shot.frame.device}` : "") +
      `). It is attached to your next message — describe what you actually see in it.` +
      (why ? ` Asked for: ${why}` : "") +
      (dark
        ? " NOTE: this frame is almost entirely black, which usually means the lens is covered by a privacy " +
          "shutter or the room is dark. Say that rather than describing a scene you cannot make out."
        : ""),
    isError: false,
  };
}

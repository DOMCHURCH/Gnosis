// The webcam, lent to the engine.
//
// The engine is Node and has no camera; getUserMedia needs a renderer. So this
// owns a hidden window (camera.html) and registers a provider with src/camera.ts,
// which is what the `camera` tool calls. The engine never imports anything from
// electron/ — see src/camera.ts for why that separation matters.
//
// Deliberately NOT part of the voice engine, even though that window also holds a
// media permission: the camera has to work with voice switched off, and a webcam
// living inside a feature called "voice" is the kind of coupling that later gets
// someone's camera opened by a wake word.

import { BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** How long a capture may take before we give up: camera open + settle + encode. */
const CAPTURE_TIMEOUT_MS = 20000;
/** The window is torn down after this much idle, so nothing lingers. */
const IDLE_CLOSE_MS = 60000;

export function registerCamera() {
  let win = null;
  let ready = null;
  let seq = 0;
  const pending = new Map();
  let idleTimer = null;

  const closeSoon = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (pending.size) return; // still working
      try { win?.destroy(); } catch { /* already gone */ }
      win = null;
      ready = null;
    }, IDLE_CLOSE_MS);
  };

  /** The hidden capture window, created on first use. */
  function ensureWindow() {
    if (win && !win.isDestroyed()) return ready;
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(here, "camera-preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    win.on("closed", () => { win = null; ready = null; });
    ready = new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: "camera window did not load" }), CAPTURE_TIMEOUT_MS);
      ipcMain.once("camera:ready", () => { clearTimeout(timer); resolve({ ok: true }); });
    });
    void win.loadFile(path.join(here, "camera.html"));
    return ready;
  }

  return {
    /** One frame, or a reason. Matches the CameraProvider contract in src/camera.ts. */
    async capture() {
      const up = await ensureWindow();
      if (up && up.ok === false) return up;
      if (!win || win.isDestroyed()) return { ok: false, error: "camera window is gone" };

      const id = ++seq;
      const frame = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, error: "camera capture timed out" });
        }, CAPTURE_TIMEOUT_MS);
        pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
        win.webContents.send("camera:capture", id);
      });
      closeSoon();
      if (!frame.ok) return { ok: false, error: frame.error ?? "camera capture failed" };
      return { ok: true, frame: { mime: frame.mime, data: frame.data, width: frame.width, height: frame.height, device: frame.device, luma: frame.luma } };
    },
    /** Called by the ipcMain handler in main.js when a frame comes back. */
    deliver(id, payload) {
      const resolve = pending.get(id);
      if (!resolve) return;
      pending.delete(id);
      resolve(payload);
    },
    stop() {
      clearTimeout(idleTimer);
      try { win?.destroy(); } catch { /* already gone */ }
      win = null;
      ready = null;
    },
  };
}

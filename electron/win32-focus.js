// IPC surface for reaching other applications on the machine.
//
// The implementation is NOT here — it lives in src/tools/focuswindow.ts, which
// is also what backs the agent's `focus_window` tool. One copy means the tool
// and the IPC can never disagree about what "focus chrome" does, and the CLI
// gets the same behaviour without Electron.

import { ipcMain } from "electron";

export function registerWin32Focus() {
  ipcMain.handle("force-focus-window", async (_e, arg) => {
    const { focusWindow } = await import("../dist/tools/focuswindow.js");
    return focusWindow(arg ?? {});
  });
  ipcMain.handle("get-running-apps", async () => {
    const { listWindows } = await import("../dist/tools/focuswindow.js");
    return listWindows();
  });
}

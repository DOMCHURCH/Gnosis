// Keyboard shortcuts.
//
// These are APP-LOCAL, registered through an application Menu, not through
// `globalShortcut`. That distinction matters: globalShortcut takes the key
// combination from the entire operating system for as long as Gnosis is running,
// so Ctrl+N and Ctrl+T would stop working in the user's editor, browser and file
// manager — including while Gnosis is closed to the tray and invisible. A menu
// accelerator fires only when a Gnosis window has focus, which is what a
// shortcut like "new session" is actually asking for.
//
// The menu itself stays hidden (the window is frameless and draws its own
// chrome); it exists purely as the accelerator table.

import { Menu, app } from "electron";

/** The table, also rendered in the settings window as a reference. */
export const SHORTCUTS = [
  { accel: "CommandOrControl+N", keys: "Ctrl+N", label: "New session", action: "new-session" },
  { accel: "CommandOrControl+T", keys: "Ctrl+T", label: "New terminal tab", action: "new-terminal" },
  { accel: "CommandOrControl+,", keys: "Ctrl+,", label: "Settings", action: "open-settings" },
  { accel: "CommandOrControl+K", keys: "Ctrl+K", label: "Model picker", action: "model-picker" },
  { accel: "CommandOrControl+L", keys: "Ctrl+L", label: "Clear chat", action: "clear-chat" },
  { accel: "CommandOrControl+Shift+S", keys: "Ctrl+Shift+S", label: "Screenshot", action: "screenshot" },
  { accel: "Escape", keys: "Esc", label: "Close overlay / panel", action: "escape" },
];

/**
 * Build the accelerator menu.
 *
 * @param send  dispatch an action to the focused renderer
 * @param onSettings  open the settings window (main-process side)
 */
export function registerShortcuts({ send, onSettings }) {
  const items = SHORTCUTS.map((s) => ({
    label: s.label,
    accelerator: s.accel,
    // `visible: false` still registers the accelerator; the frameless window has
    // no menu bar to show it in.
    visible: false,
    click: () => {
      if (s.action === "open-settings") onSettings();
      else send(s.action);
    },
  }));

  // Keep the standard edit accelerators alive. Without a menu, Ctrl+C/V/A stop
  // working in the renderer's inputs and the terminal — a frameless window with
  // a custom menu loses the defaults Electron would otherwise supply.
  const template = [
    {
      label: "Edit",
      visible: false,
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" },
        { role: "selectAll" },
      ],
    },
    { label: "Gnosis", visible: false, submenu: items },
    // Devtools stay reachable; this is a developer's tool.
    {
      label: "View",
      visible: false,
      submenu: [{ role: "toggleDevTools" }, { role: "reload" }, { role: "forceReload" }],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  app.on("will-quit", () => Menu.setApplicationMenu(null));
  return menu;
}

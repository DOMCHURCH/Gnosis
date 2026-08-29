// Native right-click menus.
//
// The renderer decides WHAT was right-clicked (it owns the DOM) and the main
// process draws the menu, because only main can build a real OS menu. So the
// renderer sends {kind, payload}, main pops the matching template, and the
// chosen command goes back to the renderer as {command, payload} for it to act
// on. Main never reaches into the UI's state itself.
//
// The one exception is "Reveal in Explorer", which is an OS action and is
// handled here directly.

import { Menu, ipcMain, shell, BrowserWindow, clipboard } from "electron";
import path from "node:path";

/** kind -> the items that kind offers. `command` is what the renderer receives. */
const TEMPLATES = {
  // Right-click on empty floor inside a zone.
  zone: (p) => [
    { label: `Add agent to ${p.zoneLabel ?? "this zone"}`, command: "zone.add" },
    { label: `Fill ${p.zoneLabel ?? "this zone"}`, command: "zone.fill" },
    { type: "separator" },
    { label: "Clear all agents", command: "floor.clear" },
  ],
  // Right-click on an agent figure.
  agent: (p) => [
    { label: `Open session${p.name ? ` · ${p.name}` : ""}`, command: "agent.open" },
    { label: "Send message…", command: "agent.message" },
    { type: "separator" },
    { label: "Remove agent", command: "agent.remove" },
  ],
  // Right-click on a file in the browser.
  file: (p) => [
    { label: "Open in editor", command: "file.open" },
    { label: "Attach to chat", command: "file.attach" },
    { type: "separator" },
    { label: "Copy path", command: "file.copyPath" },
    { label: "Reveal in Explorer", command: "file.reveal" },
  ],
};

export function registerContextMenus({ getRoot }) {
  ipcMain.on("menu:show", (event, req) => {
    const kind = req?.kind;
    const payload = req?.payload ?? {};
    const build = TEMPLATES[kind];
    if (!build) return;

    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;

    const template = build(payload).map((item) =>
      item.type === "separator"
        ? item
        : {
            label: item.label,
            click: () => {
              // OS-level actions never round-trip through the renderer.
              if (item.command === "file.copyPath") {
                clipboard.writeText(absolute(getRoot(), payload.path));
                return;
              }
              if (item.command === "file.reveal") {
                shell.showItemInFolder(absolute(getRoot(), payload.path));
                return;
              }
              if (win.isDestroyed()) return;
              win.webContents.send("menu:command", { command: item.command, payload });
            },
          },
    );

    Menu.buildFromTemplate(template).popup({ window: win });
  });
}

/** File-browser paths are relative to the session root; the OS needs absolutes. */
function absolute(root, p) {
  const rel = String(p ?? "");
  if (!rel) return root ?? "";
  return path.isAbsolute(rel) ? rel : path.join(root ?? "", rel);
}

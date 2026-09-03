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
                const abs = absolute(getRoot(), payload.path);
                if (abs) clipboard.writeText(abs);
                return;
              }
              if (item.command === "file.reveal") {
                // A path outside root (a "\\host\share\x" UNC form, or plain
                // ../ traversal) must never reach shell.showItemInFolder: on a
                // UNC path, Explorer opens an outbound SMB connection to
                // whatever host is named, which is a well-known way to leak
                // the machine's NTLM hash. This same renderer is served over
                // HTTP to LAN browsers (see shell-preload.cjs), so a payload
                // here is not necessarily hand-typed by the local user.
                const abs = absolute(getRoot(), payload.path);
                if (abs) shell.showItemInFolder(abs);
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

/**
 * File-browser paths are relative to the session root; the OS needs
 * absolutes. Returns null (never a guess) when the resolved path would
 * escape root — a `..` traversal, a UNC path (`\\host\share\...`), or an
 * absolute path on a different drive. Callers must not act on a null result.
 */
function absolute(root, p) {
  // path.resolve("") returns the PROCESS'S cwd, not "no root" — checking
  // truthiness AFTER resolving would silently treat "no session root
  // configured" as "resolve against wherever Electron's main process
  // happens to be running from", which is not the same thing as refusing.
  if (!root) return null;
  const rel = String(p ?? "");
  const rootResolved = path.resolve(root);
  if (!rel) return rootResolved;
  const resolved = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(rootResolved, rel);
  const within = path.relative(rootResolved, resolved);
  return within === "" || (!within.startsWith("..") && !path.isAbsolute(within)) ? resolved : null;
}

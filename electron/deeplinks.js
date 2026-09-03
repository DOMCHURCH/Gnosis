// gnosis:// deep links.
//
//   gnosis://session/<name>   open, or create, a named session
//   gnosis://file/<path>      reveal a file in the file browser
//   gnosis://serve            make sure the server is up and focus the window
//
// On Windows a link arrives one of two ways: as an argv entry on a cold start,
// or through the `second-instance` event when the app is already running (the
// single-instance lock means the OS launches a second process that hands its
// argv to the first and exits). Both paths funnel into the same handler.

import { app } from "electron";

const SCHEME = "gnosis";

/**
 * Defense in depth for gnosis://file/<path>. A gnosis:// link is trivially
 * attacker-triggerable — any webpage or email link, no confirmation beyond
 * the OS's own protocol-launch prompt — so the path it names is hardened
 * here regardless of what the current renderer does with it (today: an
 * inert @<path> reference dropped into the chat input, never read or
 * revealed automatically — but that must not be the only thing stopping a
 * UNC or traversal path from doing something worse if that ever changes).
 * Rejects a UNC-shaped path, `..` traversal, and anything implausibly long.
 */
function safeFilePath(rest) {
  if (!rest || rest.length > 4096) return null;
  if (rest.startsWith("\\\\") || rest.startsWith("//")) return null; // UNC
  if (rest.split(/[\\/]+/).includes("..")) return null; // traversal
  return rest;
}

/** Parse a gnosis:// URL into an action, or null if it is not one of ours. */
export function parseDeepLink(raw) {
  if (typeof raw !== "string") return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== `${SCHEME}:`) return null;

  // gnosis://session/foo parses with host="session" and pathname="/foo".
  const kind = u.hostname || u.pathname.replace(/^\/+/, "").split("/")[0] || "";
  const rest = decodeURIComponent(
    (u.hostname ? u.pathname : u.pathname.replace(/^\/*[^/]*/, "")).replace(/^\/+/, ""),
  ).trim();

  switch (kind) {
    case "session":
      // A name is required; gnosis://session/ alone is ambiguous.
      return rest ? { action: "session", name: rest } : null;
    case "file": {
      const safe = safeFilePath(rest);
      return safe ? { action: "file", path: safe } : null;
    }
    case "serve":
      return { action: "serve" };
    default:
      return null;
  }
}

/** The first gnosis:// URL in an argv array, if any. */
export function linkFromArgv(argv) {
  for (const a of argv ?? []) {
    if (typeof a === "string" && a.toLowerCase().startsWith(`${SCHEME}://`)) return a;
  }
  return null;
}

/**
 * Claim the scheme and route incoming links.
 *
 * @param handle  called with a parsed action
 */
export function registerDeepLinks(handle) {
  // In dev the executable is electron.exe, so the registration has to name this
  // script explicitly or Windows would hand gnosis:// links to a bare Electron.
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(SCHEME, process.execPath, [process.argv[1]]);
  } else {
    app.setAsDefaultProtocolClient(SCHEME);
  }

  const route = (raw) => {
    const parsed = parseDeepLink(raw);
    if (parsed) handle(parsed);
    return !!parsed;
  };

  // Already-running instance: the OS starts a second process, the lock bounces
  // it, and its argv shows up here.
  app.on("second-instance", (_e, argv) => {
    const link = linkFromArgv(argv);
    if (link) route(link);
  });

  // macOS/Linux path; harmless on Windows.
  app.on("open-url", (e, url) => {
    e.preventDefault();
    route(url);
  });

  return { pending: linkFromArgv(process.argv), route };
}

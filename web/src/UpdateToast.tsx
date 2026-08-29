// "A new version is staged" toast.
//
// Deliberately passive. electron-updater downloads in the background, and this
// only appears once the bytes are on disk and an install is one restart away.
// Nothing restarts on its own: an agent mid-turn losing its process to an
// installer would be the worst possible time for an update.

import { useEffect, useState } from "react";
import { Z } from "./layers";
import type { ShellBridge } from "./TopBar";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

export function UpdateToast(props: { shell: ShellBridge }) {
  const [version, setVersion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => props.shell.onUpdateReady((i) => setVersion(i?.version ?? "")), [props.shell]);

  if (version === null || dismissed) return null;

  return (
    <div
      data-testid="update-toast"
      style={{
        position: "fixed",
        right: 18,
        bottom: 18,
        zIndex: Z.updateToast,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 14px",
        borderRadius: 16,
        fontFamily: MONO,
        fontSize: 10,
        letterSpacing: 1,
        color: "#C9D1D9",
        background: "linear-gradient(160deg, rgba(28,28,40,0.97), rgba(16,16,23,0.97))",
        border: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "0 18px 40px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06), 0 0 30px -14px #22D3EE",
      }}
    >
      <span>
        Gnosis {version ? `v${version}` : "update"} is ready — restart to update
      </span>
      <button
        type="button"
        onClick={() => props.shell.restartToUpdate()}
        style={{
          fontFamily: MONO, fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase",
          background: "#12121c", color: "#22D3EE", border: "1px solid rgba(34,211,238,0.45)",
          borderRadius: 999, padding: "6px 12px", cursor: "pointer",
        }}
      >
        Restart
      </button>
      <button
        type="button"
        title="Later"
        onClick={() => setDismissed(true)}
        style={{ fontFamily: MONO, fontSize: 11, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer", padding: "0 2px" }}
      >
        ✕
      </button>
    </div>
  );
}

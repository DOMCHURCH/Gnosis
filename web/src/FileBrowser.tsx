import { useEffect, useState, useCallback } from "react";
import type { TreeNode, TreeResult, FilePreview } from "./filetypes";
import { apiGet } from "./api";
import { Z } from "./layers";
import { Overlay } from "./Overlay";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

// The FILES tab body: the active session's cwd as a file tree. Folders expand in
// place; a file click previews it in a modal; the + button attaches the file to the
// next message. Refreshes when the tab changes, a tool touches files (fileEpoch,
// driven by the existing tool.end event stream — no polling), or the panel's own
// refresh button bumps refreshToken (for a change made outside dom's own tools,
// which fileEpoch can't see). The surrounding panel shell (the collapsible
// section it sits in) lives in Sidebar.
export function FilesBody(props: { tabId: number | null; fileEpoch: number; refreshToken?: number; onAttach: (path: string) => void }) {
  const { tabId, fileEpoch, refreshToken } = props;
  const [data, setData] = useState<TreeResult | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  // Which root the tree shows. ~/Gnosis is pinned: the agent's own output lands
  // there regardless of where the session is, so it must be reachable without
  // navigating out of the session's cwd (which the tree cannot do anyway — every
  // path is confined to its root).
  const [root, setRoot] = useState<"session" | "gnosis">("session");
  const rootParam: Record<string, string> = root === "gnosis" ? { root: "gnosis" } : {};

  const refresh = useCallback(() => {
    if (tabId == null && root !== "gnosis") { setData(null); return; }
    void apiGet<TreeResult>("/api/tree", { tabId: tabId ?? 0, ...(root === "gnosis" ? { root: "gnosis" } : {}) }).then((r) => setData(r));
  }, [tabId, root]);

  useEffect(() => { refresh(); setExpanded({}); }, [refresh, fileEpoch, refreshToken]);

  const openFile = (node: TreeNode) => {
    setLoadingPreview(true);
    setPreview({ path: node.path, content: "", truncated: false });
    void apiGet<FilePreview>("/api/file", { tabId: tabId ?? 0, path: node.path, ...rootParam }).then((r) => {
      setLoadingPreview(false);
      setPreview(r ?? { path: node.path, content: "(could not read file)", truncated: false });
    });
  };

  const rootTab = (id: "session" | "gnosis", label: string, title: string) => (
    <button type="button" title={title} onClick={() => setRoot(id)}
      style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 1, padding: "3px 7px", cursor: "pointer",
        background: root === id ? "#23232F" : "transparent", color: root === id ? "#22D3EE" : "#6B6B7B",
        border: `1px solid ${root === id ? "#22D3EE" : "#2C2C3E"}` }}>{label}</button>
  );
  const switcher = (
    <div style={{ display: "flex", gap: 4, padding: "0 2px 6px" }}>
      {rootTab("session", "SESSION", "files under the session's working directory")}
      {rootTab("gnosis", "~/Gnosis", "the agent's own output: screenshots and files written without a path")}
    </div>
  );

  return (
    <>
      {switcher}
      {tabId == null && root !== "gnosis" ? (
        <div style={{ fontSize: 10, color: "#4A4A58", padding: 8 }}>no session</div>
      ) : data == null ? (
        <div style={{ fontSize: 10, color: "#4A4A58", padding: 8 }}>loading…</div>
      ) : data.tree.length === 0 ? (
        <div style={{ fontSize: 10, color: "#4A4A58", padding: 8 }}>
          {root === "gnosis" ? "~/Gnosis is empty — screenshots and files written without a path land here" : "empty"}
        </div>
      ) : (
        <TreeList nodes={data.tree} depth={0} expanded={expanded} setExpanded={setExpanded} onFile={openFile} onAttach={props.onAttach} />
      )}
      {data?.truncated && <div style={{ fontSize: 9, color: "#4A4A58", padding: 8 }}>…tree truncated</div>}
      {preview && (
        <FilePreviewModal preview={preview} loading={loadingPreview} onClose={() => setPreview(null)} onAttach={() => { props.onAttach(preview.path); setPreview(null); }} />
      )}
    </>
  );
}

// Shared tree renderer. `onAttach` is optional — the Obsidian tab omits the + button.
export function TreeList(props: { nodes: TreeNode[]; depth: number; expanded: Record<string, boolean>; setExpanded: (fn: (e: Record<string, boolean>) => Record<string, boolean>) => void; onFile: (n: TreeNode) => void; onAttach?: (path: string) => void }) {
  // Native right-click menu, desktop only: a browser has no Menu to pop, and
  // "Reveal in Explorer" means nothing there.
  const shell = (window as unknown as { gnosisShell?: { showMenu(kind: string, p: Record<string, unknown>): void } }).gnosisShell;
  const onContext = (n: TreeNode) => (e: React.MouseEvent) => {
    if (!shell || n.type !== "file") return;
    e.preventDefault();
    e.stopPropagation();
    shell.showMenu("file", { path: n.path, name: n.name });
  };
  const { nodes, depth, expanded } = props;
  return (
    <>
      {nodes.map((n) => {
        const isOpen = !!expanded[n.path];
        return (
          <div key={n.path}>
            <div onContextMenu={onContext(n)} style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: depth * 12, cursor: "pointer" }}>
              <div
                onClick={() => (n.type === "dir" ? props.setExpanded((e) => ({ ...e, [n.path]: !e[n.path] })) : props.onFile(n))}
                style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 5, padding: "3px 4px", overflow: "hidden" }}
              >
                <span style={{ fontSize: 10, color: n.type === "dir" ? "#22D3EE" : "#4A4A58", width: 10, flex: "0 0 10px" }}>
                  {n.type === "dir" ? (isOpen ? "▾" : "▸") : "·"}
                </span>
                <span style={{ fontSize: 11, color: n.type === "dir" ? "#C9C9D6" : "#8A8A9B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.name}</span>
              </div>
              {n.type === "file" && props.onAttach && (
                <button type="button" title="attach to next message" onClick={() => props.onAttach!(n.path)}
                  style={{ fontFamily: MONO, fontSize: 11, lineHeight: 1, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer", padding: "0 4px", flex: "0 0 auto" }}>+</button>
              )}
            </div>
            {n.type === "dir" && isOpen && n.children && n.children.length > 0 && (
              <TreeList nodes={n.children} depth={depth + 1} expanded={props.expanded} setExpanded={props.setExpanded} onFile={props.onFile} onAttach={props.onAttach} />
            )}
          </div>
        );
      })}
    </>
  );
}

function FilePreviewModal(props: { preview: FilePreview; loading: boolean; onClose: () => void; onAttach: () => void }) {
  const { preview } = props;
  return (
    // Portalled: see Overlay.tsx. A `fixed` overlay rendered inside the left
    // panel is not full-screen, because the panel's hover transform makes it the
    // containing block.
    <Overlay onClose={props.onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          // Bounded, and centred rather than edge to edge.
          //
          // This was `align="stretch"` with `height: 100%`, which ran the panel
          // the full height of the viewport. In the desktop shell the title bar
          // is a FIXED, frameless strip drawn over the page, so the preview's own
          // header — the one holding ✕ — slid underneath it and could not be
          // clicked. There was no way out of a file preview except Escape, which
          // nothing told you about.
          //
          // 86vh leaves the header clear of the title bar at the top and the
          // dock at the bottom, whatever the window height.
          width: "min(980px, 92vw)", height: "min(760px, 86vh)",
          background: "#101017", border: "1px solid #2C2C3E", borderRadius: 18,
          display: "flex", flexDirection: "column", fontFamily: MONO, overflow: "hidden",
          boxShadow: "0 30px 80px -20px rgba(0,0,0,0.9)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 22px", borderBottom: "1px solid #2C2C3E", flex: "0 0 auto" }}>
          <span style={{ fontSize: 12, letterSpacing: 1, color: "#22D3EE", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{preview.path}</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
            <button type="button" onClick={props.onAttach} style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1, background: "#22D3EE", color: "#0D0D12", border: 0, padding: "7px 13px", cursor: "pointer", borderRadius: 7 }}>+ ATTACH</button>
            {/* A real target, not a 14px glyph with 4px of padding. */}
            <button type="button" onClick={props.onClose} title="close (Esc)" aria-label="Close preview" style={{ fontFamily: MONO, fontSize: 13, lineHeight: 1, background: "transparent", color: "#8A8A9B", border: "1px solid #2C2C3E", borderRadius: 10, cursor: "pointer", width: 34, height: 32, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
          </div>
        </div>
        <pre style={{ margin: 0, flex: "1 1 auto", minHeight: 0, overflow: "auto", padding: "22px 26px", fontSize: 12.5, lineHeight: 1.75, color: "#C9C9D6", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {props.loading ? "loading…" : preview.content || "(empty file)"}
        </pre>
        {preview.truncated && <div style={{ fontSize: 9, color: "#4A4A58", padding: "10px 22px", borderTop: "1px solid #2C2C3E", flex: "0 0 auto" }}>preview truncated at 256 KB</div>}
      </div>
    </Overlay>
  );
}

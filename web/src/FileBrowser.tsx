import { useEffect, useState, useCallback } from "react";
import type { TreeNode, TreeResult, FilePreview } from "./filetypes";
import { apiGet } from "./api";
import { Z } from "./layers";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

// The FILES tab body: the active session's cwd as a file tree. Folders expand in
// place; a file click previews it in a modal; the + button attaches the file to the
// next message. Refreshes when the tab changes or a tool touches files (fileEpoch,
// driven by the existing tool.end event stream — no polling). The surrounding panel
// shell (collapse + tab switcher) lives in LeftPanel.
export function FilesBody(props: { tabId: number | null; fileEpoch: number; onAttach: (path: string) => void }) {
  const { tabId, fileEpoch } = props;
  const [data, setData] = useState<TreeResult | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  const refresh = useCallback(() => {
    if (tabId == null) { setData(null); return; }
    void apiGet<TreeResult>("/api/tree", { tabId }).then((r) => setData(r));
  }, [tabId]);

  useEffect(() => { refresh(); }, [refresh, fileEpoch]);

  const openFile = (node: TreeNode) => {
    if (tabId == null) return;
    setLoadingPreview(true);
    setPreview({ path: node.path, content: "", truncated: false });
    void apiGet<FilePreview>("/api/file", { tabId, path: node.path }).then((r) => {
      setLoadingPreview(false);
      setPreview(r ?? { path: node.path, content: "(could not read file)", truncated: false });
    });
  };

  return (
    <>
      {tabId == null ? (
        <div style={{ fontSize: 10, color: "#4A4A58", padding: 8 }}>no session</div>
      ) : data == null ? (
        <div style={{ fontSize: 10, color: "#4A4A58", padding: 8 }}>loading…</div>
      ) : data.tree.length === 0 ? (
        <div style={{ fontSize: 10, color: "#4A4A58", padding: 8 }}>empty</div>
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
  const { nodes, depth, expanded } = props;
  return (
    <>
      {nodes.map((n) => {
        const isOpen = !!expanded[n.path];
        return (
          <div key={n.path}>
            <div style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: depth * 12, cursor: "pointer" }}>
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
    <div onClick={props.onClose} style={{ position: "fixed", inset: 0, background: "rgba(5,5,8,0.72)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: Z.overlay }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(860px, 92vw)", maxHeight: "86vh", background: "#101017", border: "2px solid #2A2A38", display: "flex", flexDirection: "column", fontFamily: MONO }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderBottom: "2px solid #2A2A38" }}>
          <span style={{ fontSize: 11, letterSpacing: 1, color: "#22D3EE", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{preview.path}</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button type="button" onClick={props.onAttach} style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1, background: "#22D3EE", color: "#0D0D12", border: 0, padding: "5px 10px", cursor: "pointer" }}>+ ATTACH</button>
            <button type="button" onClick={props.onClose} style={{ fontFamily: MONO, fontSize: 12, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer" }}>✕</button>
          </div>
        </div>
        <pre style={{ margin: 0, flex: "1 1 auto", overflow: "auto", padding: 12, fontSize: 11, lineHeight: 1.5, color: "#C9C9D6", whiteSpace: "pre" }}>
          {props.loading ? "loading…" : preview.content || "(empty file)"}
        </pre>
        {preview.truncated && <div style={{ fontSize: 9, color: "#4A4A58", padding: "6px 12px", borderTop: "2px solid #2A2A38" }}>preview truncated at 256 KB</div>}
      </div>
    </div>
  );
}

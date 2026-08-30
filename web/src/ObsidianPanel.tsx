import { useState } from "react";
import type { TreeNode, VaultTree, FilePreview } from "./filetypes";
import { apiGet } from "./api";
import { TreeList } from "./FileBrowser";
import { Markdown } from "./Markdown";
import { Z } from "./layers";
import { Overlay } from "./Overlay";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

/** Flatten the vault tree to a list of file paths (for wikilink resolution). */
function flatten(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type === "file") out.push(n.path);
    else if (n.children) flatten(n.children, out);
  }
  return out;
}

/** Resolve an Obsidian [[target]] to a vault note path: exact path first, then a
 * case-insensitive basename match (with/without .md). Returns null if unresolved. */
function resolveWikilink(paths: string[], target: string): string | null {
  const want = target.replace(/\.md$/i, "").toLowerCase();
  const withMd = (p: string) => p.toLowerCase() === want + ".md";
  const byPath = paths.find((p) => withMd(p) || p.toLowerCase() === want);
  if (byPath) return byPath;
  const base = (p: string) => p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/i, "").toLowerCase();
  return paths.find((p) => base(p) === want) ?? null;
}

interface OpenNote { path: string; content: string; truncated: boolean; loading: boolean; missing?: boolean }

// The OBSIDIAN tab body: the vault's .md notes as a tree. Clicking a note renders it
// as formatted markdown; [[wikilinks]] are links that open the target note in place.
// The tree comes from the parent (one fetch, refreshed on vaultEpoch).
export function ObsidianBody(props: { vault: VaultTree | null }) {
  const { vault } = props;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState<OpenNote | null>(null);
  const [nav, setNav] = useState<string[]>([]); // back stack of note paths

  const paths = vault ? flatten(vault.tree) : [];

  const load = (path: string) => {
    setNote({ path, content: "", truncated: false, loading: true });
    void apiGet<FilePreview>("/api/vault/note", { path }).then((r) => {
      if (r) setNote({ path, content: r.content, truncated: r.truncated, loading: false });
      else setNote({ path, content: "", truncated: false, loading: false, missing: true });
    });
  };

  const openNote = (path: string) => { setNav([]); load(path); };

  const followWikilink = (target: string) => {
    const path = resolveWikilink(paths, target);
    if (!path) { setNote((n) => (n ? { ...n } : n)); setNote({ path: target, content: "", truncated: false, loading: false, missing: true }); return; }
    setNav((s) => (note ? [...s, note.path] : s));
    load(path);
  };

  const back = () => {
    setNav((s) => {
      if (!s.length) return s;
      const prev = s[s.length - 1]!;
      load(prev);
      return s.slice(0, -1);
    });
  };

  if (!vault || !vault.configured) {
    return (
      <div style={{ fontSize: 10, color: "#4A4A58", padding: 10, lineHeight: 1.6 }}>
        no vault configured — set <span style={{ color: "#8A8A9B" }}>obsidianVault</span> in config or add a{" "}
        <span style={{ color: "#8A8A9B" }}>vault:</span> line to ~/.dom/AGENTS.md
      </div>
    );
  }

  return (
    <>
      {vault.tree.length === 0 ? (
        <div style={{ fontSize: 10, color: "#4A4A58", padding: 8 }}>no notes</div>
      ) : (
        <TreeList nodes={vault.tree} depth={0} expanded={expanded} setExpanded={setExpanded} onFile={(n) => openNote(n.path)} />
      )}
      {vault.truncated && <div style={{ fontSize: 9, color: "#4A4A58", padding: 8 }}>…tree truncated</div>}
      {note && (
        <NoteModal note={note} canBack={nav.length > 0} onBack={back} onClose={() => { setNote(null); setNav([]); }} onWikilink={followWikilink} />
      )}
    </>
  );
}

function NoteModal(props: { note: OpenNote; canBack: boolean; onBack: () => void; onClose: () => void; onWikilink: (target: string) => void }) {
  const { note } = props;
  const title = note.path.slice(note.path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  return (
    // Portalled for the same reason as the file preview: an overlay rendered
    // inside a panel that has a transform is not full-screen. See Overlay.tsx.
    <Overlay onClose={props.onClose} align="stretch">
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(900px, 94vw)", height: "100%", margin: "0 auto", background: "#101017", borderLeft: "1px solid #2C2C3E", borderRight: "1px solid #2C2C3E", display: "flex", flexDirection: "column", fontFamily: MONO, boxShadow: "0 0 80px -20px rgba(0,0,0,0.9)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 22px", borderBottom: "1px solid #2C2C3E", flex: "0 0 auto" }}>
          {props.canBack && (
            <button type="button" onClick={props.onBack} title="back" style={{ fontFamily: MONO, fontSize: 12, background: "transparent", color: "#A78BFA", border: 0, cursor: "pointer" }}>←</button>
          )}
          <span style={{ fontSize: 12, letterSpacing: 1, color: "#A78BFA", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
          <button type="button" onClick={props.onClose} style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 12, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ flex: "1 1 auto", minHeight: 0, overflow: "auto", padding: "22px 26px 32px", lineHeight: 1.75, fontSize: 12.5 }}>
          {note.loading ? (
            <div style={{ fontSize: 11, color: "#4A4A58", padding: 8 }}>loading…</div>
          ) : note.missing ? (
            <div style={{ fontSize: 11, color: "#F87171", padding: 8 }}>note not found: {note.path}</div>
          ) : (
            <Markdown text={note.content} onWikilink={props.onWikilink} />
          )}
        </div>
        {note.truncated && <div style={{ fontSize: 9, color: "#4A4A58", padding: "10px 22px", borderTop: "1px solid #2C2C3E", flex: "0 0 auto" }}>note truncated at 256 KB</div>}
      </div>
    </Overlay>
  );
}

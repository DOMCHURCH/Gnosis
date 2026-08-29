// Drag files from the desktop straight onto the chat.
//
// A second path to the same place the paperclip goes: both end at app.tsx's
// addFiles(), which is what gates on the model's modalities and stages base64
// blocks. Nothing about attachment handling is duplicated here — this component
// only turns a drop into a File[].
//
// Works in a browser too. Dropping a file on a web page is a web feature, not an
// Electron one, so there is no reason to gate it on the desktop shell.

import { forwardRef, useCallback, useRef, useState } from "react";
import { Z } from "./layers";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

/** Does this drag actually carry files? Dragging selected TEXT across the page
 * also fires dragover, and lighting up a "drop to attach" overlay for that is
 * a lie about what will happen. */
function hasFiles(e: React.DragEvent): boolean {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (dt.items?.length) return Array.from(dt.items).some((i) => i.kind === "file");
  return Array.from(dt.types ?? []).includes("Files");
}

/** Ref-forwarding: the chat dock measures its own height to drive the resize
 * handle, so wrapping it must not cost the caller its ref. */
export const DropZone = forwardRef<HTMLDivElement, {
  onFiles: (files: File[]) => void;
  children: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
  testId?: string;
}>(function DropZone(props, ref) {
  const [over, setOver] = useState(false);
  // dragenter/dragleave fire for every child element the pointer crosses, so a
  // boolean would flicker off the moment the cursor moved between children.
  // Counting enters and leaves is the standard fix.
  const depth = useRef(0);

  const reset = useCallback(() => {
    depth.current = 0;
    setOver(false);
  }, []);

  return (
    <div
      ref={ref}
      data-testid={props.testId}
      className={props.className}
      style={{ position: "relative", ...props.style }}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        // Without preventDefault the browser navigates to the dropped file and
        // the whole UI is replaced by it.
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current -= 1;
        if (depth.current <= 0) reset();
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        reset();
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length) props.onFiles(files);
      }}
    >
      {props.children}
      {over && (
        <div
          data-testid="drop-zone-overlay"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: Z.dropZone,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            borderRadius: 16,
            background: "linear-gradient(160deg, rgba(34,211,238,0.14), rgba(232,121,249,0.10))",
            backdropFilter: "blur(2px)",
            boxShadow: "inset 0 0 0 2px rgba(34,211,238,0.65), inset 0 0 40px rgba(34,211,238,0.18)",
          }}
        >
          <span
            style={{
              fontFamily: MONO,
              fontSize: 10,
              letterSpacing: 3,
              textTransform: "uppercase",
              color: "#22D3EE",
              background: "rgba(13,13,18,0.75)",
              border: "1px solid rgba(34,211,238,0.4)",
              borderRadius: 999,
              padding: "8px 16px",
              boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
            }}
          >
            drop to attach
          </span>
        </div>
      )}
    </div>
  );
});

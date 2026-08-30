import { createPortal } from "react-dom";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { Z } from "./layers";

/**
 * A full-screen overlay that is actually full-screen.
 *
 * `position: fixed` is only relative to the VIEWPORT while no ancestor
 * establishes a containing block. A `transform`, `filter`, `backdrop-filter`,
 * `perspective`, `contain` or `will-change` on any ancestor silently changes
 * that: the element is then positioned against — and clipped to — that ancestor
 * instead.
 *
 * That is what broke the file and note previews. They render inside the left
 * panel, and the panel grew a `transform: translateY(-2px)` hover lift. You are
 * hovering the panel at the instant you click a file in it, so `inset: 0`
 * resolved to the 264px sidebar: the dim backdrop covered only the sidebar while
 * the modal's own content overflowed across the floor and the chat with nothing
 * behind it. Twice this was "fixed" by adjusting the modal's own background and
 * z-index, and twice it could not land, because the modal's CSS was never the
 * problem.
 *
 * Portalling to <body> puts the overlay outside every one of those ancestors, so
 * no styling decision made on a panel can reach it again.
 */
export function Overlay(props: {
  onClose?: () => void;
  /** Center the child (a modal) or let it fill (a full-height panel). */
  align?: "center" | "stretch";
  children: ReactNode;
}) {
  // The page scrolls now (see clay.css), so without this the content behind an
  // open overlay scrolls under it when you use the wheel — and the scrollbar
  // gutter stays visible beside a backdrop that is otherwise edge to edge.
  useEffect(() => {
    // <html> owns the scrollbar in the desktop shell, not <body>, so both are
    // locked — otherwise the gutter stays and the backdrop stops 15px short.
    const de = document.documentElement;
    const prev = [de.style.overflow, document.body.style.overflow];
    de.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    return () => { de.style.overflow = prev[0]; document.body.style.overflow = prev[1]; };
  }, []);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      data-testid="overlay-backdrop"
      onClick={props.onClose}
      style={{
        position: "fixed",
        inset: 0,
        // Opaque enough to actually hide what is behind it. The old value read as
        // "transparent text bleeding through" precisely because the layer under
        // it was still legible.
        background: "rgba(6, 6, 10, 0.86)",
        // The floating tier is the one place glass belongs — see the glass rule
        // in clay.css. The token keeps this modal, OverlayModal and the drag
        // overlay agreeing on what "a dimmed page" looks like.
        backdropFilter: "var(--clay-glass-thin, blur(3px))",
        display: "flex",
        alignItems: props.align === "stretch" ? "stretch" : "center",
        justifyContent: "center",
        zIndex: Z.overlay,
        padding: props.align === "stretch" ? 0 : 24,
        boxSizing: "border-box",
      }}
    >
      {props.children}
    </div>,
    document.body,
  );
}

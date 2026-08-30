/**
 * One z-index scale for the whole browser UI.
 *
 * Every stacked element imports its layer from here instead of inventing a
 * number, so "what covers what" is a property of this file rather than an
 * archaeology exercise across a dozen components. The rule the UI obeys:
 *
 *   floor  <  session selector  <  left/right panels  <  page chrome
 *          <  docks  <  floating windows  <  modals  <  permission prompts
 *
 * Nothing overlaps another element in normal use — the layout keeps the fixed
 * chrome in its own gutters (see GUTTER below) — so these values decide only
 * what wins while something is deliberately drawn over the page: a sheet, a
 * modal, or a prompt that must be answered.
 */
export const Z = {
  /** The office floor container: the page's floor, everything else sits above it. */
  floor: 1,
  /** Drawn inside the floor: the 2px context meter across its top edge. */
  floorMeter: 2,
  /** The minimap, over the floor but under anything the user reads. */
  floorMinimap: 3,
  /** Cards over the floor: the task plan and the selected agent's telemetry. */
  floorCard: 4,
  /** Popups anchored inside a panel (the composer's @-file autocomplete). */
  inlinePopup: 5,
  /** The session selector — the desktop rail and its mobile bottom bar. */
  sessionSelector: 10,
  /** The left panel (files/obsidian/connections/webhooks) and the right jobs panel. */
  panel: 20,
  /** Fixed page chrome: the view/serve toggle, the FILES/JOBS/TERMINAL buttons. */
  chrome: 30,
  /** Bottom docks: the terminal dock and the mobile bottom nav. */
  dock: 40,
  /** The detached chat window — a window you dragged out sits above the docks. */
  float: 45,
  /** The view switcher (FLOOR / KANBAN / SERVE / TERMINAL).
   *
   * Above the docks and the detached chat on purpose: it is the ONLY way to
   * change view, so anything that covers it strands you. It used to sit at
   * `chrome` (30) — under the terminal dock at 40 — and at `top: 10`, which in
   * the desktop shell is underneath the frameless title bar at 55. Between them
   * that meant switching to Kanban or opening the terminal hid the switcher, and
   * the only way back was to kill the app.
   *
   * Still below `overlay`: a modal is meant to be answered, and every modal can
   * now be closed. */
  viewToggle: 48,
  /** The drop-to-attach overlay, inside the chat panel it belongs to. Above the
   * panel's own content, below anything that covers the page. */
  dropZone: 25,
  /** Modals, bottom sheets and lightboxes: deliberately over the whole page. */
  overlay: 50,
  /** The desktop shell's title bar. Above modals, not below them: the window is
   * frameless there, so these ARE the close and minimise buttons. A modal that
   * covered them would leave the user with a window they cannot put away. Still
   * under permission prompts, which nothing may cover. */
  titleBar: 55,
  /** Permission prompts. Always on top: nothing may cover a decision. */
  permission: 60,
  /** The update toast. Above prompts only because it is transient, dismissible,
   * and never blocks one — it sits in a corner, not over the dialog. */
  updateToast: 70,
} as const;

/**
 * Space the page reserves for fixed chrome so it never lands on content.
 *
 * `top` clears the fixed chrome band in the top-right corner (FLOOR / KANBAN /
 * SERVE / TERMINAL); `bottom` clears the FILES / JOBS buttons that appear in the
 * bottom corners at narrow widths. Layering alone would only decide which of two
 * overlapping things wins — reserving the band is what stops them overlapping.
 *
 * The terminal dock reserves its own height on top of this, via the --dom-dock-h
 * custom property it sets while open (see Terminal.tsx).
 */
export const GUTTER = { top: 44, bottom: 60 } as const;

export type Layer = (typeof Z)[keyof typeof Z];

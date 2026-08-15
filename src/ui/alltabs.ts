// Pure layout for the /alltabs split view: a tiled (or, on narrow terminals,
// stacked) read-only overview of every tab's recent transcript. Kept free of Ink
// so the geometry — column count, cell widths, borders, truncation — is unit-
// testable; the <AllTabs> component only maps this to colored <Text> nodes.

import type { Glyphs } from "./terminal.js";
import type { Badge } from "../tabs.js";

export interface CellInput {
  name: string;
  active: boolean;
  badge: Badge;
  busy: boolean;
  /** Most-recent transcript preview lines (oldest→newest), untrimmed. */
  lines: string[];
}

export interface Tile {
  /** Numbered/badged title shown in the top border. */
  title: string;
  active: boolean;
  top: string; // top border incl. title, exactly cellWidth wide
  body: string[]; // exactly contentRows rows, each innerWidth wide (no borders)
  bottom: string; // bottom border, exactly cellWidth wide
  innerWidth: number;
}

export interface TiledLayout {
  kind: "tiled";
  columns: number;
  cellWidth: number;
  grid: Tile[][];
  rows: number; // total logical rows the view occupies
}

export interface StackItem {
  title: string;
  active: boolean;
  lines: string[]; // exactly 3 preview rows (blank-padded), width-trimmed
}

export interface StackedLayout {
  kind: "stacked";
  items: StackItem[];
  rows: number;
}

/** 1 tab → 1 across, 2–4 → 2 across, 5+ → 3 across. */
export function gridColumns(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  return 3;
}

function clip(s: string, w: number): string {
  if (w <= 0) return "";
  if (s.length <= w) return s;
  return w <= 1 ? "…" : s.slice(0, w - 1) + "…";
}
function pad(s: string, w: number): string {
  const c = clip(s, w);
  return c + " ".repeat(Math.max(0, w - c.length));
}
function lastN<T>(arr: T[], n: number): T[] {
  return arr.length <= n ? arr : arr.slice(arr.length - n);
}

function badgeMark(badge: Badge, legacy: boolean): string {
  if (badge === "approval") return legacy ? "!" : "●";
  if (badge === "output") return legacy ? "*" : "•";
  return "";
}
function titleFor(index: number, c: CellInput, legacy: boolean): string {
  const mark = badgeMark(c.badge, legacy);
  return `${index + 1}:${c.name}${c.busy ? "…" : ""}${mark ? " " + mark : ""}`;
}

/** `╭─ title ─────╮` — the title embedded in the top border, padded to cellWidth. */
function topBorder(title: string, cellWidth: number, g: Glyphs): string {
  const between = Math.max(0, cellWidth - 2); // between the two corners
  let seg = `${g.h} ${title} `;
  if (seg.length > between) seg = clip(seg, between);
  seg = seg + g.h.repeat(Math.max(0, between - seg.length));
  return g.tl + seg + g.tr;
}
function bottomBorder(cellWidth: number, g: Glyphs): string {
  return g.bl + g.h.repeat(Math.max(0, cellWidth - 2)) + g.br;
}

export function layoutAllTabs(opts: {
  cells: CellInput[];
  width: number;
  glyphs: Glyphs;
  contentRows?: number;
  stacked?: boolean;
}): TiledLayout | StackedLayout {
  const g = opts.glyphs;
  const legacy = g.chevron === ">";
  const cells = opts.cells;
  const stacked = opts.stacked ?? opts.width < 100;

  if (stacked) {
    // Narrow terminals: a plain stacked list, 3 preview lines per tab, no tiling.
    const inner = Math.max(4, opts.width);
    const items: StackItem[] = cells.map((c, i) => {
      const lines = lastN(c.lines, 3).map((l) => clip(l, inner - 2));
      while (lines.length < 3) lines.unshift("");
      return { title: `${c.active ? "▍" : " "}${titleFor(i, c, legacy)}`, active: c.active, lines };
    });
    return { kind: "stacked", items, rows: items.length * 4 }; // header + 3 lines each
  }

  const columns = gridColumns(cells.length);
  const cellWidth = Math.floor((opts.width - (columns - 1)) / columns); // 1-col gap between cells
  const innerWidth = Math.max(1, cellWidth - 4); // │ + space … space + │
  const contentRows = opts.contentRows ?? 6;

  const tiles: Tile[] = cells.map((c, i) => {
    const title = titleFor(i, c, legacy);
    const body = lastN(c.lines, contentRows).map((l) => pad(l, innerWidth));
    while (body.length < contentRows) body.unshift(" ".repeat(innerWidth)); // tail-align content
    return {
      title,
      active: c.active,
      top: topBorder(title, cellWidth, g),
      body,
      bottom: bottomBorder(cellWidth, g),
      innerWidth,
    };
  });

  const grid: Tile[][] = [];
  for (let i = 0; i < tiles.length; i += columns) grid.push(tiles.slice(i, i + columns));
  return { kind: "tiled", columns, cellWidth, grid, rows: grid.length * (contentRows + 2) };
}

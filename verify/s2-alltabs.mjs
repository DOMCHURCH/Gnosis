// Verify: the /alltabs split-view layout — column counts (2 across for 2-4, 3 for
// 5+), tiled cells sized to the width with the tab name in the top border, and the
// stacked fallback below 100 columns (3 lines per tab, no tiling).
import { layoutAllTabs, gridColumns } from "../dist/ui/alltabs.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "✓" : "✗"} ${name}`); if (!cond) fails++; };

const G = { h: "─", tl: "╭", tr: "╮", bl: "╰", br: "╯", v: "│", chevron: "❯", diamond: "◆", barFull: "▓", barEmpty: "░", dot: "●", mid: "·" };
const cell = (name, active, lines = []) => ({ name, active, badge: "none", busy: false, lines });

// --- column counts ------------------------------------------------------------
ok("1 tab → 1 column", gridColumns(1) === 1);
ok("2 tabs → 2 columns", gridColumns(2) === 2);
ok("4 tabs → 2 columns", gridColumns(4) === 2);
ok("5 tabs → 3 columns", gridColumns(5) === 3);
ok("9 tabs → 3 columns", gridColumns(9) === 3);

// --- tiled layout (>= 100 cols) -----------------------------------------------
{
  const cells = [cell("main", true, ["hello", "world"]), cell("worker", false, ["building"]), cell("logs", false, [])];
  const lay = layoutAllTabs({ cells, width: 120, glyphs: G, contentRows: 6, stacked: false });
  ok("wide → tiled", lay.kind === "tiled");
  ok("3 tabs tile 2 across", lay.columns === 2);
  ok("grid has 2 rows (2 + 1)", lay.grid.length === 2);
  const c0 = lay.grid[0][0];
  ok("cells are sized to the width (2 per row + 1 gap)", lay.cellWidth === Math.floor((120 - 1) / 2));
  ok("top border is exactly cellWidth wide", c0.top.length === lay.cellWidth);
  ok("bottom border is exactly cellWidth wide", c0.bottom.length === lay.cellWidth);
  ok("each cell has contentRows body rows", c0.body.length === 6);
  ok("body rows are innerWidth wide", c0.body.every((r) => r.length === c0.innerWidth));
  ok("the tab name (numbered) is in the top border", c0.top.includes("1:main"));
  ok("the second cell is numbered 2:worker", lay.grid[0][1].top.includes("2:worker"));
  ok("the active cell is flagged", c0.active === true && lay.grid[0][1].active === false);
  ok("total rows = gridRows * (contentRows + 2)", lay.rows === 2 * (6 + 2));
  // content is tail-aligned at the bottom of the cell
  ok("most-recent line shows at the bottom of the cell", c0.body[c0.body.length - 1].startsWith("world"));
}

// --- live update: newer lines change the rendered body ------------------------
{
  const a = layoutAllTabs({ cells: [cell("t", true, ["one"])], width: 120, glyphs: G, stacked: false });
  const b = layoutAllTabs({ cells: [cell("t", true, ["one", "two"])], width: 120, glyphs: G, stacked: false });
  const lastA = a.grid[0][0].body.at(-1);
  const lastB = b.grid[0][0].body.at(-1);
  ok("a new line updates the cell body (live)", lastA.startsWith("one") && lastB.startsWith("two"));
}

// --- stacked fallback (< 100 cols) --------------------------------------------
{
  const cells = [cell("main", true, ["a", "b", "c", "d"]), cell("worker", false, ["x"])];
  const lay = layoutAllTabs({ cells, width: 80, glyphs: G, stacked: true });
  ok("narrow → stacked (no tiling)", lay.kind === "stacked");
  ok("stacked has one item per tab", lay.items.length === 2);
  ok("stacked shows 3 lines per tab", lay.items.every((it) => it.lines.length === 3));
  ok("stacked titles are numbered + active-marked", lay.items[0].title.includes("1:main") && lay.items[0].title.includes("▍"));
  ok("stacked rows = tabs * 4 (header + 3)", lay.rows === 2 * 4);
  ok("stacked tail-aligns the last 3 lines", lay.items[0].lines.join("|").includes("b") && lay.items[0].lines.at(-1).includes("d"));
}

// --- auto stacked threshold at width < 100 (no explicit flag) ------------------
ok("width 99 auto-stacks", layoutAllTabs({ cells: [cell("a", true)], width: 99, glyphs: G }).kind === "stacked");
ok("width 100 auto-tiles", layoutAllTabs({ cells: [cell("a", true)], width: 100, glyphs: G }).kind === "tiled");

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

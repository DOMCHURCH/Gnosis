// The model picker's ALL / FREE / PAID tabs and their ordering.
//
// Pure and dependency-free so the browser and the Node verify run import the same
// rules — the same arrangement filekind.js and chatgroups.js use.
//
// A catalog of ~290 models is not something you scroll. Splitting it by what it
// costs, and ranking the paid side cheapest-first, is how someone actually picks:
// "what can I run for nothing" and "what is the cheapest thing that will do it"
// are the two real questions.

export const TABS = [
  { key: "all", label: "ALL" },
  { key: "free", label: "FREE" },
  { key: "paid", label: "PAID" },
];

/**
 * Price per 1M input tokens, read back out of the row's hint ("$3.00/$15.00 per
 * 1M in/out"). A row with no figure — a free model, or one whose provider
 * publishes no prices — is 0 and sorts to the front.
 *
 * Reading it back from the hint rather than carrying a separate number keeps the
 * sort keyed to the exact figure the user is looking at.
 */
export function promptPrice(hint) {
  const m = /\$([\d.]+)\//.exec(String(hint ?? ""));
  return m ? parseFloat(m[1]) : 0;
}

/** How many rows each tab holds, for the counts in the strip. */
export function tierCounts(items) {
  const c = { all: items.length, free: 0, paid: 0 };
  for (const it of items) {
    if (it.tier === "free") c.free++;
    else if (it.tier === "paid") c.paid++;
  }
  return c;
}

/** True when this list has tiers to split on. The session, file and history
 *  pickers do not, and a tab strip over them would be noise. */
export function isTabbed(kind, items) {
  return kind === "model" && items.some((it) => it.tier);
}

/**
 * The rows to show for a tab + filter, in display order.
 *
 * PAID is cheapest-first — the order you shop a price list in. ALL puts the free
 * models first and then runs cheap-to-expensive, so the top of the list is always
 * the least you could spend. FREE keeps the catalog's own order: they all cost the
 * same, so there is nothing to rank them by.
 */
export function visibleItems(items, tab, filter, tabbed = true) {
  const q = String(filter ?? "").trim().toLowerCase();
  let out = items;
  if (tabbed && tab !== "all") out = out.filter((it) => it.tier === tab);
  if (q) {
    out = out.filter(
      (it) =>
        String(it.label ?? "").toLowerCase().includes(q) ||
        String(it.value ?? "").toLowerCase().includes(q) ||
        // The hint carries the price/context line, so "free" and "1M" filter too.
        String(it.hint ?? "").toLowerCase().includes(q),
    );
  }
  if (tabbed && (tab === "paid" || tab === "all")) {
    out = out.slice().sort((a, b) => {
      if (tab === "all" && (a.tier === "free") !== (b.tier === "free")) return a.tier === "free" ? -1 : 1;
      return promptPrice(a.hint) - promptPrice(b.hint) || String(a.label).localeCompare(String(b.label));
    });
  }
  return out;
}

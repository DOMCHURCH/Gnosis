// Fuzzy subsequence matching + scoring for @-file completion. Higher score = better
// match; null means the query is not a subsequence of the target at all. Bonuses for
// contiguous runs and matches at path/word boundaries (after / \ . _ - or start), a
// small penalty for skipped characters, and a nudge toward shorter targets.

export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;
  let ti = 0;
  let score = 0;
  let prev = -2;
  let streak = 0;
  for (const c of q) {
    const found = t.indexOf(c, ti);
    if (found === -1) return null;
    if (found === prev + 1) {
      streak++;
      score += 5 + streak; // contiguous run
    } else {
      streak = 0;
      score += 1;
    }
    const before = found === 0 ? "/" : t[found - 1]!;
    if (/[/\\._ -]/.test(before)) score += 10; // boundary bonus
    score -= Math.min(found - ti, 4) * 0.5; // distance penalty
    prev = found;
    ti = found + 1;
  }
  score += Math.max(0, 20 - t.length * 0.1); // prefer shorter targets
  return score;
}

/** Filter + rank items by fuzzy match. Ties break on the item's `rank` (lower =
 * more central, e.g. repo-map order). Empty query returns items unchanged. */
export function fuzzyFilter<T extends { search?: string; label: string; rank?: number }>(items: T[], query: string): T[] {
  const q = query.replace(/\s+/g, "");
  if (!q) return items;
  const scored: Array<{ item: T; s: number }> = [];
  for (const it of items) {
    const s = fuzzyScore(q, it.search ?? it.label);
    if (s !== null) scored.push({ item: it, s });
  }
  scored.sort((a, b) => b.s - a.s || (a.item.rank ?? Infinity) - (b.item.rank ?? Infinity));
  return scored.map((x) => x.item);
}

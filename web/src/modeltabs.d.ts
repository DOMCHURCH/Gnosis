export type TabKey = "all" | "free" | "paid";
export interface TabDef {
  key: TabKey;
  label: string;
}
/** One row of a selection overlay (see OverlayState["items"]). */
export interface TabItem {
  value: string;
  label: string;
  hint?: string;
  tier?: string;
}
export const TABS: readonly TabDef[];
export function promptPrice(hint: string | undefined): number;
export function tierCounts(items: TabItem[]): Record<TabKey, number>;
export function isTabbed(kind: string, items: TabItem[]): boolean;
export function visibleItems(items: TabItem[], tab: TabKey, filter: string, tabbed?: boolean): TabItem[];

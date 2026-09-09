import type { ThreadSummary } from "../../shared/types";

/** Each eyebrow renders as its own 15px line plus the row's 1px flex gap. */
export function estimateRowHeight(row: ThreadSummary | undefined): number {
  if (!row) return 74;
  const lines = Number(Boolean(row.draft)) + Number(row.band === "needs_you" && Boolean(row.attentionReason)) + Number(Boolean(row.noReplyBy)) + Number(Boolean(row.wakeAt));
  return 74 + 16 * lines;
}

/** measure() clears cached heights; re-read the mounted elements instead. */
export function remeasureRows(parent: ParentNode | null, measureElement: (element: HTMLElement) => void): void {
  parent?.querySelectorAll<HTMLElement>("[data-index]").forEach(measureElement);
}

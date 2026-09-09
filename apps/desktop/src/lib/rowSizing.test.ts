import { test } from "node:test";
import assert from "node:assert/strict";
import { Virtualizer } from "@tanstack/react-virtual";
import type { ThreadSummary } from "../../shared/types";
import { estimateRowHeight, remeasureRows } from "./rowSizing";

const row = (fields: Partial<ThreadSummary>) => fields as ThreadSummary;
test("drafts and stacked eyebrows each reserve their own line", () => {
  assert.equal(estimateRowHeight(row({})), 74);
  assert.equal(estimateRowHeight(row({ draft: {} as NonNullable<ThreadSummary["draft"]> })), 90);
  assert.equal(estimateRowHeight(row({ draft: {} as NonNullable<ThreadSummary["draft"]>, band: "needs_you", attentionReason: "A question", noReplyBy: 1, wakeAt: 1 })), 138);
});

test("font readiness remeasures mounted rows without erasing other measured heights", () => {
  const virtualizer = new Virtualizer({ count: 3, getScrollElement: () => null, estimateSize: () => 74, scrollToFn: () => {}, observeElementRect: () => {}, observeElementOffset: () => {} });
  virtualizer.getTotalSize();
  virtualizer.resizeItem(0, 90);
  virtualizer.resizeItem(1, 74);
  virtualizer.resizeItem(2, 106);
  // Only the draft is currently mounted; the offscreen row keeps its measured height.
  const element = { dataset: { index: "0" } } as unknown as HTMLElement;
  const parent = { querySelectorAll: () => [element] } as unknown as ParentNode;
  remeasureRows(parent, (node) => virtualizer.resizeItem(Number(node.dataset.index), 92));
  assert.equal(virtualizer.getTotalSize(), 92 + 74 + 106);
  virtualizer.measure();
  assert.equal(virtualizer.getTotalSize(), 74 * 3, "the old font callback lost the actual heights");
});

// What a receipt is allowed to say, and the words it says it in.
//
// summarise() in packages/pixel-service rolls a message's fetches into one of
// three states, and this maps each to a line and a tooltip. The rules it
// enforces are the point of the feature:
//
//   opened             something rendered the message. It reports that
//                      software asked for the image, not that a person read.
//   possibly automatic only machine-looking fetches. Apple Mail Privacy
//                      Protection and scanners fetch on arrival, so this is
//                      not evidence of a reader.
//   no signal          nothing fetched. This is NOT unread: images are widely
//                      blocked, and the word "unread" never appears here.
//
// The count of fetches is never shown as a count of people, because one
// person's client can fetch an image many times and a proxy can fetch it once
// for many people.

import { summarise } from "../../../../packages/pixel-service/src/classify.mjs";
import type { ReadReceiptEventRow } from "@arcforma/store";
import type { ReceiptStatus, ReceiptSummary } from "../../shared/types.js";

/** The one sentence that has to be true of the whole feature, said wherever it is explained. */
export const RECEIPT_HONESTY = "A receipt reports that software asked for an image, not that a person read anything.";

const TOOLTIP: Record<ReceiptStatus, string> = {
  opened: `Something rendered this message and fetched its image. ${RECEIPT_HONESTY}`,
  "possibly automatic": `The only fetches look automatic: Apple Mail Privacy Protection loads images the moment mail arrives, and scanners open everything. ${RECEIPT_HONESTY}`,
  "no signal": `Nothing has fetched the image. That does not mean unread: images are widely blocked, so a message that was read can sit here for good. ${RECEIPT_HONESTY}`,
};

/**
 * The state of one message's receipt, for the reading pane and the list row.
 * Events for the message go in; nothing but the three states comes out.
 */
export function receiptSummary(events: ReadReceiptEventRow[]): ReceiptSummary {
  const s = summarise(events.map((e) => ({ at: e.at, grade: e.grade })));
  const status = s.status as ReceiptStatus;
  return { status, firstAt: s.firstAt, count: s.count, tip: TOOLTIP[status] };
}

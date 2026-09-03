// The words a read receipt is shown in, in one place, so the reading pane and
// the list row cannot drift apart on what they claim.
//
// The main process decides which of the three states a message is in, using
// summarise() from packages/pixel-service, and sends the explaining sentence
// with it. Nothing here invents a status, and nothing here says "unread":
// a message with no fetch has no signal, because images are widely blocked.

import { relativeTime } from "./recipients";
import type { ReceiptSummary } from "../../shared/types";

/** The one sentence that has to be true of the feature, said wherever it is explained. */
export const RECEIPT_HONESTY = "A receipt reports that software asked for an image, not that a person read anything.";

/** What the compose control does, and what it cannot know, in the words the tooltip uses. */
export const RECEIPT_COMPOSE_TIP =
  "Adds a hidden one pixel image to this message only. If the recipient's client fetches it, you learn that software asked for the image, and when. You do not learn that a person read the message, and nothing coming back does not mean unread: images are widely blocked.";

/** What the control says when there is no service to talk to. Naming the file is the point: it is how someone gets one. */
export const RECEIPT_NO_SERVICE_TIP =
  "Read receipts need a pixel service you deploy yourself. packages/pixel-service/README.md walks through it; the address and token go in Settings.";

/** The line itself: "Opened 2 hours ago", "Possibly automatic", "No signal". Never a count of opens, which is not a count of people. */
export function receiptLine(receipt: ReceiptSummary, now = Date.now()): string {
  if (receipt.status === "opened" && receipt.firstAt !== null) return `Opened ${relativeTime(receipt.firstAt, now)}`;
  if (receipt.status === "possibly automatic") return "Possibly automatic";
  return "No signal";
}

// The wording is the feature. A read receipt is weak evidence dressed up as a strong claim, so what
// these lines say and refuse to say is the thing worth pinning: every other part of the pipeline can
// change without anyone being misled, but a line that reads "unread" or counts opens as people
// misleads on every message it appears on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RECEIPT_COMPOSE_TIP, RECEIPT_HONESTY, RECEIPT_NO_SERVICE_TIP, receiptLine } from "./receipts";
import type { ReceiptSummary } from "../../shared/types";

const at = Date.UTC(2026, 8, 3, 12, 0, 0);
const summary = (over: Partial<ReceiptSummary>): ReceiptSummary => ({ status: "no signal", firstAt: null, count: 0, tip: "", ...over });

test("an opened receipt says when, in the same relative words the rest of the app uses", () => {
  const line = receiptLine(summary({ status: "opened", firstAt: at - 2 * 60 * 60 * 1000, count: 3 }), at);
  assert.match(line, /^Opened /);
  assert.doesNotMatch(line, /\d+\s*(opens|times|people|readers)/i, "a fetch count is not a headcount");
});

test("the three states never say unread, and never say read either", () => {
  const lines = [
    receiptLine(summary({ status: "opened", firstAt: at - 1000, count: 1 }), at),
    receiptLine(summary({ status: "possibly automatic", firstAt: at - 1000, count: 1 }), at),
    receiptLine(summary({}), at),
  ];
  for (const line of lines) {
    assert.doesNotMatch(line, /unread/i, `"${line}" must never call a message unread: images are widely blocked`);
    assert.doesNotMatch(line, /\bread\b/i, `"${line}" must not claim a person read anything`);
  }
  assert.equal(lines[2], "No signal", "nothing fetched is an absence of evidence, not a verdict");
});

test("a machine-looking fetch is hedged, not reported as an open", () => {
  assert.equal(receiptLine(summary({ status: "possibly automatic", firstAt: at - 1000, count: 9 }), at), "Possibly automatic");
});

test("an opened status with no timestamp degrades instead of printing a broken date", () => {
  assert.equal(receiptLine(summary({ status: "opened", firstAt: null, count: 1 }), at), "No signal");
});

test("every explanation shown to a person carries the limit of what a receipt is", () => {
  for (const tip of [RECEIPT_COMPOSE_TIP, RECEIPT_NO_SERVICE_TIP]) {
    assert.ok(tip.length > 0);
  }
  assert.match(RECEIPT_HONESTY, /not that a person read/i);
  assert.match(RECEIPT_COMPOSE_TIP, /do not learn that a person read|does not mean unread/i, "the compose tip has to say what it cannot tell you");
  assert.match(RECEIPT_NO_SERVICE_TIP, /pixel-service/, "naming the file is how someone gets a service at all");
});

test("the voice rules hold here too: no emoji, no em dash", () => {
  for (const s of [RECEIPT_HONESTY, RECEIPT_COMPOSE_TIP, RECEIPT_NO_SERVICE_TIP]) {
    assert.doesNotMatch(s, /[—–]/, "no em or en dashes");
    assert.doesNotMatch(s, /\p{Extended_Pictographic}/u, "no emoji");
  }
});

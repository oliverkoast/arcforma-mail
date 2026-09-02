import { test } from "node:test";
import assert from "node:assert/strict";
import { anyTruncated, calendarEventTip, clip, placeTooltip, threadRowTip } from "./tooltip";

const viewport = { width: 1200, height: 800 };
const tip = { width: 200, height: 40 };

test("placeTooltip: below the element and centred on it when there is room", () => {
  const p = placeTooltip({ left: 500, top: 100, width: 32, height: 32 }, tip, viewport);
  assert.equal(p.above, false);
  assert.equal(p.top, 100 + 32 + 6);
  assert.equal(p.left, 500 + 16 - 100);
});

test("placeTooltip: flips above when the card would run off the bottom", () => {
  const p = placeTooltip({ left: 500, top: 770, width: 32, height: 20 }, tip, viewport);
  assert.equal(p.above, true);
  assert.equal(p.top, 770 - 6 - 40);
  assert.ok(p.top + tip.height <= 770, "never covers the element");
});

test("placeTooltip: clamps to the viewport edges, left and right", () => {
  const left = placeTooltip({ left: 4, top: 100, width: 20, height: 20 }, tip, viewport);
  assert.equal(left.left, 8);
  const right = placeTooltip({ left: 1190, top: 100, width: 20, height: 20 }, tip, viewport);
  assert.equal(right.left, 1200 - 8 - 200);
});

test("placeTooltip: when neither side fits, the roomier side wins and the card stays inside the viewport", () => {
  const small = { width: 400, height: 60 };
  const below = placeTooltip({ left: 100, top: 10, width: 40, height: 20 }, tip, small);
  assert.equal(below.above, false, "more room below than above");
  assert.ok(below.top >= 8 && below.top + tip.height <= small.height - 8);
  const above = placeTooltip({ left: 100, top: 35, width: 40, height: 20 }, tip, small);
  assert.equal(above.above, true, "more room above than below");
  assert.ok(above.top >= 8 && above.top + tip.height <= small.height - 8);
});

test("anyTruncated: true only when some element's text is wider than its box", () => {
  assert.equal(anyTruncated([{ scrollWidth: 200, clientWidth: 200 }]), false);
  assert.equal(anyTruncated([{ scrollWidth: 200, clientWidth: 200 }, { scrollWidth: 301, clientWidth: 300 }]), true);
  assert.equal(anyTruncated([]), false);
});

test("threadRowTip: full subject, the first 140 characters of the snippet, the account", () => {
  const long = "word ".repeat(60).trim();
  const t = threadRowTip("Re: Kickoff next week", long, "you@example.com");
  const lines = t.split("\n");
  assert.equal(lines[0], "Re: Kickoff next week");
  assert.ok(lines[1]!.length <= 141 && lines[1]!.endsWith("…"));
  assert.equal(lines[2], "you@example.com");
  assert.equal(threadRowTip("", "", null), "(no subject)");
  assert.equal(clip("short one", 140), "short one");
});

test("calendarEventTip: title, time range, and the other attendees by name", () => {
  const fmt = (t: number) => (t === 1 ? "9:30 AM" : "10:00 AM");
  const text = calendarEventTip(
    { summary: "Arcforma standup", startAt: 1, endAt: 2, allDay: false, attendees: [{ email: "you@example.com", name: null, self: true }, { email: "jules@arcforma.ai", name: "Jules Park", self: false }] },
    fmt
  );
  assert.equal(text, "Arcforma standup\n9:30 AM to 10:00 AM\nWith Jules Park");
  assert.equal(calendarEventTip({ summary: "Offsite", startAt: 1, endAt: 2, allDay: true, attendees: [] }, fmt), "Offsite\nAll day");
});

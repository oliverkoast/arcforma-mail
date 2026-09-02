import { test } from "node:test";
import assert from "node:assert/strict";
import { coalesce, formatSlot, formatSlots, freeSlots, isBusy, mergeBusy, timeZoneLabel, SLOT_MS } from "../shared/availability.js";

const LA = "America/Los_Angeles";
const H = 3_600_000;
const M = 60_000;

test("mergeBusy joins overlapping and touching blocks from several accounts and drops empty ones", () => {
  const T = Date.UTC(2026, 8, 2, 16); // 09:00 PT
  const merged = mergeBusy([
    { start: T + 2 * H, end: T + 3 * H }, // personal, later
    { start: T, end: T + H }, // arcforma
    { start: T + 30 * M, end: T + 90 * M }, // formai, overlaps the first
    { start: T + 90 * M, end: T + 2 * H }, // touches the previous end
    { start: T + 5 * H, end: T + 5 * H }, // empty
    { start: T + 6 * H, end: T + 5 * H }, // inverted
  ]);
  assert.deepEqual(merged, [{ start: T, end: T + 3 * H }]);
  assert.equal(isBusy(merged, T + 3 * H, T + 3 * H + SLOT_MS), false);
  assert.equal(isBusy(merged, T + 3 * H - 1, T + 3 * H + SLOT_MS), true);
});

test("freeSlots walks a day in 30-minute steps and skips anything touching a busy block", () => {
  const day = Date.UTC(2026, 8, 2, 16); // 09:00 PT
  const busy = [
    { start: day + H, end: day + 2 * H }, // 10:00 to 11:00
    { start: day + 2 * H + 15 * M, end: day + 2 * H + 20 * M }, // 11:15 to 11:20, a five-minute hold still kills the half hour
  ];
  const free = freeSlots(busy, day, day + 4 * H);
  assert.deepEqual(
    free.map((s) => (s.start - day) / M),
    [0, 30, 150, 180, 210]
  );
  assert.deepEqual(coalesce(free.slice(0, 2)), [{ start: day, end: day + H }]);
  assert.deepEqual(freeSlots([], day, day + 45 * M).length, 1, "a partial trailing step is not offered");
});

test("formatSlot uses the fixed zone: PT label, 24-hour clock, and the right wall clock on both sides of a DST change", () => {
  assert.equal(formatSlot({ start: Date.UTC(2026, 8, 2, 17), end: Date.UTC(2026, 8, 2, 17, 30) }, LA), "Wed Sep 2, 10:00 to 10:30 PT");
  // 2026-11-01 is the US fall-back day. 07:30Z is 00:30 PDT; 09:30Z is 01:30 PST (the hour repeats).
  assert.equal(formatSlot({ start: Date.UTC(2026, 10, 1, 7, 30), end: Date.UTC(2026, 10, 1, 8) }, LA), "Sun Nov 1, 00:30 to 01:00 PT");
  assert.equal(formatSlot({ start: Date.UTC(2026, 10, 1, 9, 30), end: Date.UTC(2026, 10, 1, 10) }, LA), "Sun Nov 1, 01:30 to 02:00 PT");
  // A slot that spans the fall-back instant really is 01:30 PDT to 01:00 PST on the wall; that is the correct label, not a bug.
  assert.equal(formatSlot({ start: Date.UTC(2026, 10, 1, 8, 30), end: Date.UTC(2026, 10, 1, 9) }, LA), "Sun Nov 1, 01:30 to 01:00 PT");
  // Spring forward, 2026-03-08: 10:00Z is 02:00 PST, which does not exist as a wall time; 10:30Z is 03:30 PDT.
  assert.equal(formatSlot({ start: Date.UTC(2026, 2, 8, 9, 30), end: Date.UTC(2026, 2, 8, 10, 30) }, LA), "Sun Mar 8, 01:30 to 03:30 PT");
  // The same instants read differently in another zone, proving the label is not the process zone.
  assert.equal(formatSlot({ start: Date.UTC(2026, 8, 2, 17), end: Date.UTC(2026, 8, 2, 17, 30) }, "Europe/London"), "Wed Sep 2, 18:00 to 18:30 BST".replace("BST", timeZoneLabel("Europe/London", Date.UTC(2026, 8, 2, 17))));
  // Crossing midnight repeats the day on the end side.
  assert.equal(formatSlot({ start: Date.UTC(2026, 8, 3, 6, 30), end: Date.UTC(2026, 8, 3, 7, 30) }, LA), "Wed Sep 2, 23:30 to Thu Sep 3 00:30 PT");
});

test("formatSlots coalesces adjacent picks into one line per range, in order", () => {
  const T = Date.UTC(2026, 8, 2, 17);
  const lines = formatSlots(
    [
      { start: T + H, end: T + H + SLOT_MS },
      { start: T, end: T + SLOT_MS },
      { start: T + SLOT_MS, end: T + H },
    ],
    LA
  );
  assert.deepEqual(lines, ["Wed Sep 2, 10:00 to 11:30 PT"]);
  assert.equal(timeZoneLabel(LA, T), "PT");
});

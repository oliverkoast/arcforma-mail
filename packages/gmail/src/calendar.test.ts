import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEventTime, syncCalendar } from "./calendar.js";
import { fakeClock, fakeTransport, fixtureJson, token } from "../test/helpers.js";

test("410 on a stale syncToken falls back to a full window fetch and maps events", async () => {
  const clock = fakeClock(Date.UTC(2026, 8, 1, 12));
  const full = fixtureJson("calendar-full.json");
  const { transport, calls } = fakeTransport([
    { status: 410, body: { error: { message: "Sync token is no longer valid", errors: [{ reason: "fullSyncRequired" }] } } },
    { status: 200, body: full },
  ]);
  const result = await syncCalendar({ accessToken: token, transport, sleep: clock.sleep, now: clock.now, syncToken: "stale" });
  assert.equal(result.fullSync, true);
  assert.match(calls[0]!.url, /syncToken=stale/);
  assert.match(calls[1]!.url, /timeMin=2026-08-31T12%3A00%3A00\.000Z&timeMax=2026-09-08T12%3A00%3A00\.000Z/);
  assert.equal(result.nextSyncToken, "sync-2");
  assert.deepEqual(result.window, { from: Date.UTC(2026, 7, 31, 12), to: Date.UTC(2026, 8, 8, 12) }, "a full sync reports the window it covered");
  assert.deepEqual(result.removed, ["ev2"]);
  assert.equal(result.upserts.length, 2);
  const [ev1, ev3] = result.upserts;
  assert.equal(ev1!.summary, "James Perse kickoff");
  assert.equal(ev1!.responseStatus, "accepted");
  assert.equal(ev1!.busy, true);
  assert.equal(ev1!.hangoutLink, "https://meet.google.com/abc-defg-hij");
  assert.equal(ev1!.attendees.length, 2);
  assert.equal(ev3!.allDay, true);
  assert.equal(ev3!.busy, false);
});

test("all-day events start at local midnight, not UTC midnight, and end at the next local midnight", () => {
  // The fixture's all-day event is "2026-09-04" to "2026-09-05". In any zone west of UTC, Date.parse would file it under Sep 3.
  const item = fixtureJson<{ items: Array<Record<string, unknown>> }>("calendar-full.json").items.find((i) => (i["start"] as { date?: string } | undefined)?.date);
  assert.ok(item);
  const start = item["start"] as { date: string };
  const end = item["end"] as { date: string };
  const [y, m, d] = start.date.split("-").map(Number) as [number, number, number];
  assert.equal(parseEventTime(start), new Date(y, m - 1, d).getTime());
  assert.equal(parseEventTime(end), new Date(y, m - 1, d + 1).getTime());
  assert.equal(parseEventTime(end)! - parseEventTime(start)!, 24 * 3_600_000);
  assert.equal(new Date(parseEventTime(start)!).getHours(), 0, "local midnight");
  assert.equal(parseEventTime({ dateTime: "2026-09-02T10:00:00-07:00" }), Date.UTC(2026, 8, 2, 17));
  assert.equal(parseEventTime({ date: "not-a-date" }), null);
  assert.equal(parseEventTime(undefined), null);
});

test("the full window reaches back windowBehindDays so past meetings are kept for the contact rail", async () => {
  const clock = fakeClock(Date.UTC(2026, 8, 1, 12));
  const { transport, calls } = fakeTransport([{ status: 200, body: { items: [], nextSyncToken: "s" } }]);
  const result = await syncCalendar({ accessToken: token, transport, sleep: clock.sleep, now: clock.now, windowDays: 14, windowBehindDays: 30 });
  assert.match(calls[0]!.url, /timeMin=2026-08-02T12%3A00%3A00\.000Z&timeMax=2026-09-15T12%3A00%3A00\.000Z/);
  assert.deepEqual(result.window, { from: Date.UTC(2026, 7, 2, 12), to: Date.UTC(2026, 8, 15, 12) });
});

test("incremental sync uses the token, pages, and backs off on 429", async () => {
  const clock = fakeClock();
  const { transport, calls } = fakeTransport([
    { status: 429, body: { error: { message: "rate", errors: [{ reason: "rateLimitExceeded" }] } }, headers: { "Retry-After": "1" } },
    { status: 200, body: { items: [], nextPageToken: "p2" } },
    { status: 200, body: { items: [], nextSyncToken: "sync-3" } },
  ]);
  const result = await syncCalendar({ accessToken: token, transport, sleep: clock.sleep, now: clock.now, syncToken: "sync-2" });
  assert.equal(result.fullSync, false);
  assert.equal(result.window, null, "an incremental sync covers no fixed window");
  assert.equal(result.nextSyncToken, "sync-3");
  assert.equal(calls.length, 3);
  assert.match(calls[2]!.url, /pageToken=p2/);
  assert.deepEqual(clock.sleeps, [1000]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archive,
  clearQueue,
  createSnooze,
  dayBoundaryBefore,
  detectBoundary,
  dueSnoozes,
  getQueue,
  getQueueItem,
  listQueueMembers,
  listThreads,
  openStore,
  queueCounts,
  rolloverDay,
  rolloverWeek,
  setQueue,
  setSetting,
  getSetting,
  threadCounts,
  toggleQueue,
  trash,
  upsertAccount,
  upsertClassification,
  upsertThreadFromGmail,
  wakeSnooze,
  weekBoundaryBefore,
  type Db,
  type GmailThreadInput,
} from "./index.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Local instants, so the boundary rules read the same in any zone. */
const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime();

// ---- boundary detection ---------------------------------------------------------

test("boundary: a gap of five hours or more that crosses a local date opens a new day at the previous activity", () => {
  const last = at(2026, 9, 1, 18, 0); // Tuesday evening
  const r = detectBoundary({ lastActiveAt: last, dayStartAt: at(2026, 8, 31, 23, 0), weekStartAt: at(2026, 8, 31, 4, 0) }, at(2026, 9, 2, 0, 30));
  assert.equal(r.newDay, true, "18:00 to 00:30 is six and a half hours across midnight");
  assert.equal(r.next.dayStartAt, last, "the day starts at the last time he was on mail the night before");
  assert.equal(r.next.lastActiveAt, at(2026, 9, 2, 0, 30));
  assert.equal(r.newWeek, false);
});

test("boundary: the first activity after 4:00 local opens a new day even when the date did not change and the gap was short", () => {
  const prev = { lastActiveAt: at(2026, 9, 2, 2, 0), dayStartAt: at(2026, 9, 1, 19, 0), weekStartAt: at(2026, 8, 31, 4, 0) };
  const r = detectBoundary(prev, at(2026, 9, 2, 9, 0));
  assert.equal(r.newDay, true, "2:00 to 9:00 crosses 4:00");
  assert.equal(r.next.dayStartAt, at(2026, 9, 2, 2, 0));
  const short = detectBoundary({ ...prev, lastActiveAt: at(2026, 9, 2, 3, 50) }, at(2026, 9, 2, 4, 10));
  assert.equal(short.newDay, true, "crossing 4:00 is the boundary, however short the gap");
});

test("boundary: gaps on the same day, and a short hop across midnight before 4:00, do nothing", () => {
  const prev = { lastActiveAt: at(2026, 9, 2, 9, 0), dayStartAt: at(2026, 9, 2, 2, 0), weekStartAt: at(2026, 8, 31, 4, 0) };
  const sameDay = detectBoundary(prev, at(2026, 9, 2, 16, 30));
  assert.equal(sameDay.newDay, false, "seven and a half hours inside one day is a long lunch, not a new day");
  assert.equal(sameDay.next.dayStartAt, prev.dayStartAt);
  assert.equal(sameDay.next.lastActiveAt, at(2026, 9, 2, 16, 30));
  const lateNight = detectBoundary({ ...prev, lastActiveAt: at(2026, 9, 2, 23, 0) }, at(2026, 9, 3, 0, 30));
  assert.equal(lateNight.newDay, false, "23:00 to 00:30 is the same evening");
  const fourHours = detectBoundary({ ...prev, lastActiveAt: at(2026, 9, 2, 22, 0) }, at(2026, 9, 3, 2, 0));
  assert.equal(fourHours.newDay, false, "a four hour gap across midnight is still the same evening");
});

test("boundary: the first activity ever opens the day at the last 4:00 and the week at the last Monday 4:00", () => {
  const now = at(2026, 9, 3, 10, 0); // Thursday
  const r = detectBoundary({ lastActiveAt: 0, dayStartAt: 0, weekStartAt: 0 }, now);
  assert.equal(r.newDay, true);
  assert.equal(r.newWeek, true);
  assert.equal(r.next.dayStartAt, at(2026, 9, 3, 4, 0));
  assert.equal(r.next.weekStartAt, at(2026, 8, 31, 4, 0));
  assert.equal(dayBoundaryBefore(at(2026, 9, 3, 3, 59)), at(2026, 9, 2, 4, 0), "before 4:00 the boundary is yesterday's");
  assert.equal(weekBoundaryBefore(at(2026, 9, 7, 3, 0)), at(2026, 8, 31, 4, 0), "Monday 3:00 is still last week");
  assert.equal(weekBoundaryBefore(at(2026, 9, 7, 4, 0)), at(2026, 9, 7, 4, 0), "Monday 4:00 starts the week");
});

test("boundary: the first activity after Monday 4:00 opens a new week; a midweek morning does not", () => {
  const week = at(2026, 8, 31, 4, 0);
  const sunday = detectBoundary({ lastActiveAt: at(2026, 9, 6, 22, 0), dayStartAt: at(2026, 9, 5, 23, 0), weekStartAt: week }, at(2026, 9, 7, 8, 0));
  assert.equal(sunday.newWeek, true);
  assert.equal(sunday.newDay, true);
  assert.equal(sunday.next.weekStartAt, at(2026, 9, 7, 4, 0));
  const wednesday = detectBoundary({ lastActiveAt: at(2026, 9, 1, 22, 0), dayStartAt: at(2026, 8, 31, 23, 0), weekStartAt: week }, at(2026, 9, 2, 8, 0));
  assert.equal(wednesday.newWeek, false);
  assert.equal(wednesday.next.weekStartAt, week);
});

// ---- membership -------------------------------------------------------------------

function tempDb(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-queues-"));
  const db = openStore(path.join(dir, "mail.db"));
  upsertAccount(db, { id: "arcforma", email: "you@example.com", consent: "internal" });
  return db;
}

const T0 = at(2026, 9, 2, 9, 0);
const DAY_START = at(2026, 9, 1, 22, 0);

function thread(id: string, msgs: Array<{ id: string; from: string; date: number; labels?: string[] }>): GmailThreadInput {
  return {
    id,
    historyId: "1",
    messages: msgs.map((m) => ({
      id: m.id,
      threadId: id,
      labelIds: m.labels ?? ["INBOX"],
      snippet: "",
      internalDate: String(m.date),
      historyId: "1",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: m.from },
          { name: "To", value: "you@example.com" },
          { name: "Subject", value: id },
          { name: "Message-ID", value: `<${m.id}@example.com>` },
        ],
      },
    })),
  };
}

/** One inbound message from a client, in the inbox, classified as given. */
function seedThread(db: Db, id: string, inboundAt: number, split: "important" | "other" = "important", labels = ["INBOX"]): void {
  upsertThreadFromGmail(db, "arcforma", thread(id, [{ id: `m-${id}`, from: `dana@northwind.example`, date: inboundAt, labels }]), { ownerAddresses: ["you@example.com"] });
  upsertClassification(db, { accountId: "arcforma", threadId: id, split, source: "rule" });
}

function seedDay(db: Db): void {
  setSetting(db, "dayStartAt", DAY_START);
  setSetting(db, "weekStartAt", at(2026, 8, 31, 4, 0));
  setSetting(db, "lastActiveAt", T0);
}

test("membership: an important inbox thread with inbound mail after dayStartAt is in Daily 0 on its own; older or other mail is not", () => {
  const db = tempDb();
  seedDay(db);
  seedThread(db, "fresh", DAY_START + HOUR);
  seedThread(db, "stale", DAY_START - HOUR);
  seedThread(db, "other", DAY_START + HOUR, "other");
  seedThread(db, "archived", DAY_START + HOUR, "important", []);
  assert.equal(getQueue(db, "arcforma", "fresh"), "daily");
  assert.equal(getQueue(db, "arcforma", "stale"), null);
  assert.equal(getQueue(db, "arcforma", "other"), null);
  assert.equal(getQueue(db, "arcforma", "archived"), null, "the automatic rule needs the thread in the inbox");
  assert.deepEqual(listQueueMembers(db, "daily").map((m) => m.thread_id), ["fresh"]);
  const list = listThreads(db, { view: "daily" });
  assert.deepEqual(list.rows.map((r) => [r.id, r.queue]), [["fresh", "daily"]]);
  assert.equal(listThreads(db, { view: "inbox" }).rows.find((r) => r.id === "fresh")?.queue, "daily", "every list carries the queue");
  assert.deepEqual(queueCounts(db), { daily: 1, weekly: 0, later: 0 });
});

test("membership: a manual W wins over the automatic Daily 0 rule, and a thread is in one queue at a time", () => {
  const db = tempDb();
  seedDay(db);
  seedThread(db, "t", DAY_START + HOUR);
  assert.equal(toggleQueue(db, "arcforma", "t", "weekly", T0), "weekly");
  assert.equal(getQueue(db, "arcforma", "t"), "weekly");
  assert.deepEqual(listQueueMembers(db, "daily"), [], "not in Daily 0 any more, even though the automatic rule would put it there");
  assert.equal(toggleQueue(db, "arcforma", "t", "daily", T0 + 1), "daily", "D on a weekly thread moves it to Daily 0");
  assert.deepEqual(queueCounts(db), { daily: 1, weekly: 0, later: 0 });
  assert.equal(toggleQueue(db, "arcforma", "t", "weekly", T0 + 2), "weekly");
  assert.equal(toggleQueue(db, "arcforma", "t", "weekly", T0 + 3), null, "W on a weekly thread takes it out");
  assert.equal(getQueue(db, "arcforma", "t"), null, "and it does not fall back into Daily 0");
  assert.equal(getQueueItem(db, "arcforma", "t")?.queue, "none");
});

test("membership: D on an automatic Daily 0 thread takes it out until newer mail arrives", () => {
  const db = tempDb();
  seedDay(db);
  seedThread(db, "t", DAY_START + HOUR);
  assert.equal(toggleQueue(db, "arcforma", "t", "daily", T0), null);
  assert.equal(getQueue(db, "arcforma", "t"), null);
  assert.equal(toggleQueue(db, "arcforma", "t", "daily", T0 + 1), "daily", "D again puts it back");
  assert.equal(toggleQueue(db, "arcforma", "t", "daily", T0 + 2), null);
  // A newer inbound message re-qualifies the thread: the exclusion was about the old mail.
  upsertThreadFromGmail(db, "arcforma", thread("t", [
    { id: "m-t", from: "dana@northwind.example", date: DAY_START + HOUR },
    { id: "m-t2", from: "dana@northwind.example", date: T0 + HOUR },
  ]), { ownerAddresses: ["you@example.com"] });
  assert.equal(getQueue(db, "arcforma", "t"), "daily");
});

test("membership: E takes a thread out of any queue and counts as cleared today; trash does the same", () => {
  const db = tempDb();
  seedDay(db);
  seedThread(db, "auto", DAY_START + HOUR);
  seedThread(db, "weekly", DAY_START - DAY);
  seedThread(db, "later", DAY_START - DAY);
  seedThread(db, "binned", DAY_START + HOUR);
  setQueue(db, "arcforma", "weekly", "weekly", "user", T0);
  setQueue(db, "arcforma", "later", "later", "rollover", T0);
  assert.deepEqual(queueCounts(db), { daily: 2, weekly: 1, later: 1 });
  archive(db, "arcforma", "auto");
  archive(db, "arcforma", "weekly");
  archive(db, "arcforma", "later");
  trash(db, "arcforma", "binned");
  assert.deepEqual(queueCounts(db), { daily: 0, weekly: 0, later: 0 });
  assert.equal(getQueueItem(db, "arcforma", "weekly"), null, "the row is gone, not parked");
  const counts = threadCounts(db);
  assert.equal(counts.clearedDaily, 2, "two Daily 0 threads were cleared today");
  assert.equal(counts.clearedWeekly, 1);
  assert.equal(clearQueue(db, "arcforma", "auto"), null, "a second E has nothing to clear");
  assert.equal(threadCounts(db).clearedDaily, 2);
});

test("membership: snoozing takes a thread out of its queue and the wake puts it in Daily 0", () => {
  const db = tempDb();
  seedDay(db);
  seedThread(db, "t", DAY_START - DAY);
  setQueue(db, "arcforma", "t", "weekly", "user", T0);
  const snooze = createSnooze(db, { accountId: "arcforma", threadId: "t", wakeAt: T0 + 2 * HOUR });
  assert.equal(getQueue(db, "arcforma", "t"), null);
  assert.equal(getQueueItem(db, "arcforma", "t"), null);
  assert.deepEqual(queueCounts(db), { daily: 0, weekly: 0, later: 0 });
  assert.equal(dueSnoozes(db, T0 + 3 * HOUR)[0]?.id, snooze.id);
  wakeSnooze(db, snooze.id, T0 + 3 * HOUR);
  assert.equal(getQueue(db, "arcforma", "t"), "daily", "the wake re-adds it to Daily 0 even though its mail predates the day");
  assert.equal(getQueueItem(db, "arcforma", "t")?.source, "wake");
  assert.equal(listThreads(db, { view: "daily" }).rows[0]?.id, "t");
});

// ---- rollover ---------------------------------------------------------------------

test("rollover: on a new day everything still in Daily 0 moves to Weekly 0, and running it again for the same day moves nothing", () => {
  const db = tempDb();
  seedDay(db);
  seedThread(db, "auto", DAY_START + HOUR);
  seedThread(db, "manual", DAY_START - DAY);
  seedThread(db, "done", DAY_START + HOUR);
  seedThread(db, "overnight", T0 + 12 * HOUR);
  setQueue(db, "arcforma", "manual", "daily", "user", T0);
  archive(db, "arcforma", "done");
  const nextDayStart = T0 + 10 * HOUR; // the last activity of the evening
  const now = T0 + 24 * HOUR;
  assert.equal(rolloverDay(db, { dayStartAt: nextDayStart, now }), 3, "auto, manual, and overnight were in Daily 0 under the old day");
  assert.equal(getQueue(db, "arcforma", "auto"), "weekly");
  assert.equal(getQueue(db, "arcforma", "manual"), "weekly");
  assert.equal(getQueue(db, "arcforma", "overnight"), "weekly");
  assert.equal(getQueueItem(db, "arcforma", "auto")?.source, "rollover");
  assert.equal(getQueue(db, "arcforma", "done"), null, "E already took it out; rollover does not resurrect it");
  assert.equal(getSetting(db, "dayStartAt"), nextDayStart);
  // A thread that arrives after the new day started is today's, and a second run must leave it alone.
  seedThread(db, "today", nextDayStart + HOUR);
  assert.equal(getQueue(db, "arcforma", "today"), "daily");
  assert.equal(rolloverDay(db, { dayStartAt: nextDayStart, now: now + 60_000 }), 0, "same boundary, nothing moves");
  assert.equal(getQueue(db, "arcforma", "today"), "daily");
  assert.deepEqual(queueCounts(db), { daily: 1, weekly: 3, later: 0 });
  assert.equal(getThreadInbox(db, "auto"), 1, "rollover archives nothing");
});

function getThreadInbox(db: Db, id: string): number {
  return (db.prepare("SELECT in_inbox FROM threads WHERE id = ?").get(id) as { in_inbox: number }).in_inbox;
}

test("rollover: the first day the app sees moves nothing into Weekly 0", () => {
  const db = tempDb();
  seedThread(db, "old", T0 - 3 * DAY);
  seedThread(db, "older", T0 - 10 * DAY);
  assert.equal(getSetting(db, "dayStartAt"), 0);
  assert.equal(rolloverDay(db, { dayStartAt: dayBoundaryBefore(T0), now: T0 }), 0);
  assert.deepEqual(queueCounts(db), { daily: 0, weekly: 0, later: 0 }, "nothing predating the first day lands in a queue");
});

test("rollover: on a new week Weekly 0 rows older than seven days drop to Later; younger ones stay; running it again is a no-op", () => {
  const db = tempDb();
  seedDay(db);
  const nextWeek = at(2026, 9, 7, 4, 0);
  const now = at(2026, 9, 7, 8, 0);
  seedThread(db, "old", now - 12 * DAY);
  seedThread(db, "recent", now - 3 * DAY);
  setQueue(db, "arcforma", "old", "weekly", "rollover", now - 9 * DAY);
  setQueue(db, "arcforma", "recent", "weekly", "rollover", now - 3 * DAY);
  assert.equal(rolloverWeek(db, { weekStartAt: nextWeek, now }), 1);
  assert.equal(getQueue(db, "arcforma", "old"), "later");
  assert.equal(getQueue(db, "arcforma", "recent"), "weekly");
  assert.equal(getSetting(db, "weekStartAt"), nextWeek);
  assert.equal(rolloverWeek(db, { weekStartAt: nextWeek, now: now + 60_000 }), 0);
  assert.deepEqual(listThreads(db, { view: "later" }).rows.map((r) => r.id), ["old"]);
  assert.deepEqual(listThreads(db, { view: "weekly" }).rows.map((r) => r.id), ["recent"]);
  assert.equal(getThreadInbox(db, "old"), 1, "Later is a queue, not an archive");
});

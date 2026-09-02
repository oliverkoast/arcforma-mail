import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore, upsertAccount, upsertThreadFromGmail, type GmailThreadInput } from "../index.js";
import { contactStats, threadsWithContact, contactName, setContactPhoto } from "./contacts.js";
import { busyIntervals, eventsWithAttendee, listEventsInRange, mergeIntervals } from "./calendar.js";
import { clearCalendarForAccount, removeStaleCalendarEvents, upsertCalendarEvents } from "./misc.js";

const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
const H = 3_600_000;
const OWNER = "you@example.com";

function thread(id: string, msgs: Array<{ id: string; from: string; to: string; cc?: string; date: number; labels?: string[] }>): GmailThreadInput {
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
          { name: "To", value: m.to },
          ...(m.cc ? [{ name: "Cc", value: m.cc }] : []),
          { name: "Subject", value: `Subject ${id}` },
          { name: "Message-ID", value: `<${m.id}@example.com>` },
        ],
      },
    })),
  };
}

function seeded() {
  const db = openStore(":memory:");
  upsertAccount(db, { id: "arcforma", email: OWNER, consent: "internal" });
  upsertAccount(db, { id: "personal", email: "you@gmail.com", consent: "external" });
  const ctx = { ownerAddresses: [OWNER, "you@gmail.com"] };
  const dana = "Dana Reyes <dana@northwind.example>";
  // Two-way: she wrote, Oliver replied.
  upsertThreadFromGmail(db, "arcforma", thread("t1", [
    { id: "m1", from: dana, to: OWNER, date: T0 - 10 * H },
    { id: "m2", from: `Oliver <${OWNER}>`, to: "dana@northwind.example", date: T0 - 9 * H, labels: ["SENT"] },
  ]), ctx);
  // Two-way on the other account, with her on Cc of the reply (display name in the header).
  upsertThreadFromGmail(db, "personal", thread("t2", [
    { id: "m3", from: "DANA@Northwind.example", to: "you@gmail.com", date: T0 - 30 * H },
    { id: "m4", from: "Oliver <you@gmail.com>", to: "someone@else.example", cc: "Dana Reyes <dana@northwind.example>", date: T0 - 29 * H, labels: ["SENT"] },
  ]), ctx);
  // One-way: she wrote, no answer.
  upsertThreadFromGmail(db, "arcforma", thread("t3", [{ id: "m5", from: dana, to: OWNER, date: T0 - 2 * H }]), ctx);
  // One-way: Oliver wrote, no answer.
  upsertThreadFromGmail(db, "arcforma", thread("t4", [{ id: "m6", from: `Oliver <${OWNER}>`, to: "dana@northwind.example", date: T0 - 1 * H, labels: ["SENT"] }]), ctx);
  // Unrelated.
  upsertThreadFromGmail(db, "arcforma", thread("t5", [{ id: "m7", from: "Sam <sam@harbor.example>", to: OWNER, date: T0 - 5 * H }]), ctx);
  return db;
}

test("contactStats counts two-way threads and the last message each way, case-insensitively", () => {
  const db = seeded();
  const s = contactStats(db, "Dana@Northwind.example");
  assert.equal(s.twoWayThreads, 2);
  assert.equal(s.threads, 4);
  assert.equal(s.lastFromAt, T0 - 2 * H);
  assert.equal(s.lastToAt, T0 - 1 * H);
  const none = contactStats(db, "nobody@nowhere.example");
  assert.deepEqual(none, { email: "nobody@nowhere.example", twoWayThreads: 0, threads: 0, lastFromAt: null, lastToAt: null });
  const sam = contactStats(db, "sam@harbor.example");
  assert.equal(sam.twoWayThreads, 0);
  assert.equal(sam.lastToAt, null);
});

test("threadsWithContact lists every thread the address touched, newest first, across accounts", () => {
  const db = seeded();
  const rows = threadsWithContact(db, "dana@northwind.example");
  assert.deepEqual(rows.map((r) => `${r.account_id}:${r.id}`), ["arcforma:t4", "arcforma:t3", "arcforma:t1", "personal:t2"]);
  assert.deepEqual(threadsWithContact(db, "dana@northwind.example", 2).map((r) => r.id), ["t4", "t3"]);
  assert.equal(contactName(db, "dana@northwind.example"), "Dana Reyes");
  assert.equal(contactName(db, "unknown@x.example"), null);
});

test("setContactPhoto records a miss as an empty string so the lookup is not repeated", () => {
  const db = seeded();
  setContactPhoto(db, "Dana@Northwind.example", null);
  const row = db.prepare("SELECT photo_url, domain FROM contacts WHERE email = ?").get("dana@northwind.example") as { photo_url: string; domain: string };
  assert.equal(row.photo_url, "");
  assert.equal(row.domain, "northwind.example");
  setContactPhoto(db, "dana@northwind.example", "https://example.com/p.jpg");
  assert.equal((db.prepare("SELECT photo_url FROM contacts WHERE email = ?").get("dana@northwind.example") as { photo_url: string }).photo_url, "https://example.com/p.jpg");
});

test("busy intervals merge across accounts and skip declined, free, all-day, and cancelled events", () => {
  const db = openStore(":memory:");
  const base = { allDay: false, status: "confirmed", busy: true, responseStatus: "accepted", hangoutLink: null, organizerEmail: null, attendees: [] };
  upsertCalendarEvents(db, "arcforma", "primary", [
    { ...base, id: "a1", summary: "A", startAt: T0, endAt: T0 + H },
    { ...base, id: "a2", summary: "Declined", startAt: T0 + 5 * H, endAt: T0 + 6 * H, responseStatus: "declined" },
    { ...base, id: "a3", summary: "Free", startAt: T0 + 7 * H, endAt: T0 + 8 * H, busy: false },
    { ...base, id: "a4", summary: "Holiday", startAt: T0, endAt: T0 + 24 * H, allDay: true },
    { ...base, id: "a5", summary: "Gone", startAt: T0 + 9 * H, endAt: T0 + 10 * H, status: "cancelled" },
  ]);
  upsertCalendarEvents(db, "personal", "primary", [
    { ...base, id: "p1", summary: "Overlaps A", startAt: T0 + H / 2, endAt: T0 + 2 * H },
    { ...base, id: "p2", summary: "Later", startAt: T0 + 3 * H, endAt: T0 + 4 * H, attendees: [{ email: "Dana@northwind.example", displayName: "Dana", responseStatus: "accepted", self: false }] },
  ]);
  const raw = busyIntervals(db, T0 - H, T0 + 24 * H);
  assert.equal(raw.length, 3);
  const merged = mergeIntervals(raw);
  assert.deepEqual(merged, [
    { start: T0, end: T0 + 2 * H },
    { start: T0 + 3 * H, end: T0 + 4 * H },
  ]);
  assert.deepEqual(listEventsInRange(db, T0 - H, T0 + 24 * H).map((e) => e.id), ["a1", "a4", "p1", "p2", "a2", "a3"]);
  const withDana = eventsWithAttendee(db, "dana@northwind.example", T0 + 2 * H);
  assert.equal(withDana.next?.id, "p2");
  assert.equal(withDana.last, null);
  const after = eventsWithAttendee(db, "dana@northwind.example", T0 + 10 * H);
  assert.equal(after.next, null);
  assert.equal(after.last?.id, "p2");
});

test("stale removal after a full sync only touches rows inside the synced window; sign-out clears one account's calendar", () => {
  const db = openStore(":memory:");
  const base = { allDay: false, status: "confirmed", busy: true, responseStatus: "accepted", hangoutLink: null, organizerEmail: null, attendees: [] };
  const D = 24 * H;
  upsertCalendarEvents(db, "arcforma", "primary", [
    { ...base, id: "old", summary: "Last month", startAt: T0 - 40 * D, endAt: T0 - 40 * D + H },
    { ...base, id: "keep", summary: "Still there", startAt: T0 + D, endAt: T0 + D + H },
    { ...base, id: "gone", summary: "Deleted remotely", startAt: T0 + 2 * D, endAt: T0 + 2 * D + H },
    { ...base, id: "far", summary: "Beyond the window", startAt: T0 + 60 * D, endAt: T0 + 60 * D + H },
    { ...base, id: "edge", summary: "Straddles the window start", startAt: T0 - 31 * D, endAt: T0 - 29 * D },
  ]);
  upsertCalendarEvents(db, "personal", "primary", [{ ...base, id: "p1", summary: "Other account", startAt: T0 + D, endAt: T0 + D + H }]);
  const window = { from: T0 - 30 * D, to: T0 + 14 * D };
  const removed = removeStaleCalendarEvents(db, "arcforma", "primary", ["keep"], window);
  assert.equal(removed, 2, "the missing row inside the window and the straddling one go; old and far stay");
  const left = (db.prepare("SELECT id FROM calendar_events WHERE account_id = 'arcforma' ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
  assert.deepEqual(left, ["far", "keep", "old"]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE account_id = 'personal'").get() as { n: number }).n, 1, "another account is never touched");
  // Without a window (legacy callers) everything not in the snapshot goes.
  assert.equal(removeStaleCalendarEvents(db, "arcforma", "primary", ["keep"]), 2);

  db.prepare("INSERT INTO calendar_sync (account_id, calendar_id, sync_token, sync_token_expires_at, last_sync_at) VALUES ('arcforma', 'primary', 'tok', ?, ?)").run(T0, T0);
  const cleared = clearCalendarForAccount(db, "arcforma");
  assert.equal(cleared.events, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE account_id = 'arcforma'").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM calendar_sync WHERE account_id = 'arcforma'").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE account_id = 'personal'").get() as { n: number }).n, 1);
});

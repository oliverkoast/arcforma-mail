import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthExpiredError, GmailApiError, GmailClient, type Transport } from "@arcforma/gmail";
import { createReminder, enqueueSend, getQueue, getQueueItem, getSend, getSetting, listDrafts, markSending, openStore, queueCounts, setQueue, setSetting, upsertAccount, upsertClassification, upsertThreadFromGmail, type Db } from "@arcforma/store";
import { rolloverToast } from "./rollover.js";
import { Scheduler, isTerminalSendError } from "./scheduler.js";

function tempDb(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-sched-"));
  const db = openStore(path.join(dir, "mail.db"));
  upsertAccount(db, { id: "arcforma", email: "you@example.com" });
  return db;
}

function clientWith(handler: () => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>): { client: GmailClient; calls: number } {
  const state = { calls: 0 };
  const transport: Transport = async () => {
    state.calls += 1;
    const r = await handler();
    return { status: r.status, headers: { get: () => null }, text: async () => JSON.stringify(r.body) };
  };
  const client = new GmailClient({ accessToken: async () => "t", transport, sleep: async () => {}, maxAttempts: 1 });
  return { client, get calls() { return state.calls; } } as { client: GmailClient; calls: number };
}

const draft = { accountId: "arcforma", threadId: null, mode: "new" as const, to: [{ email: "dana@northwind.example", name: "Dana" }], cc: [], bcc: [], subject: "Hello", bodyHtml: "<p>Hi</p>", quotedHtml: "" };
const T0 = 1_800_000_000_000;

test("a row left in sending by a crash is failed at start and its draft restored, never resent", async () => {
  const db = tempDb();
  const row = enqueueSend(db, { accountId: "arcforma", rawMime: "RAW", sendAt: T0, undoUntil: T0, meta: { draft } });
  assert.equal(markSending(db, row.id), true);
  const api = clientWith(() => ({ status: 200, body: { id: "g1", threadId: "t1" } }));
  const scheduler = new Scheduler(db, { client: () => api.client }, { poke: () => {} }, { now: () => T0 + 60_000, notify: () => {} });
  const interrupted = scheduler.recoverInterruptedSends();
  assert.deepEqual(interrupted.map((r) => r.id), [row.id]);
  assert.equal(getSend(db, row.id)!.status, "failed");
  const drafts = listDrafts(db);
  assert.equal(drafts.length, 1, "the draft is back under Drafts");
  assert.equal(drafts[0]!.subject, "Hello");
  await scheduler.tick();
  assert.equal(api.calls, 0, "nothing was sent");
});

test("two workers ticking over the same due row send it exactly once", async () => {
  const db = tempDb();
  enqueueSend(db, { accountId: "arcforma", rawMime: "RAW", sendAt: T0, undoUntil: T0, meta: { draft } });
  const api = clientWith(async () => {
    await new Promise((r) => setTimeout(r, 20));
    return { status: 200, body: { id: "g1", threadId: "t1" } };
  });
  const accounts = { client: () => api.client };
  const a = new Scheduler(db, accounts, { poke: () => {} }, { now: () => T0 + 1, notify: () => {} });
  const b = new Scheduler(db, accounts, { poke: () => {} }, { now: () => T0 + 1, notify: () => {} });
  await Promise.all([a.tick(), b.tick(), a.tick()]);
  assert.equal(api.calls, 1, "the conditional queued -> sending update lets only one worker through");
  const rows = (db.prepare("SELECT status, gmail_message_id FROM send_queue").all() as Array<{ status: string; gmail_message_id: string | null }>).map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ status: "sent", gmail_message_id: "g1" }]);
});

test("transient failures retry with backoff; terminal ones fail the row and hand the draft back", async () => {
  const db = tempDb();
  const retry = enqueueSend(db, { accountId: "arcforma", rawMime: "RAW", sendAt: T0, undoUntil: T0, meta: { draft } });
  let status = 429;
  const api = clientWith(() => ({ status, body: { error: { message: status === 429 ? "Rate limit" : "Invalid To header", errors: [{ reason: status === 429 ? "rateLimitExceeded" : "invalidArgument" }] } } }));
  const scheduler = new Scheduler(db, { client: () => api.client }, { poke: () => {} }, { now: () => T0 + 1, notify: () => {} });
  await scheduler.tick();
  let row = getSend(db, retry.id)!;
  assert.equal(row.status, "queued", "a rate limit puts the row back in the queue");
  assert.equal(row.attempts, 1);
  assert.ok(row.send_at >= T0 + 60_000, "with a later send time");
  assert.equal(listDrafts(db).length, 0, "no draft is restored for a retry");
  // Bring the time forward past the retry, and make the API reject the message for good.
  status = 400;
  const later = new Scheduler(db, { client: () => api.client }, { poke: () => {} }, { now: () => row.send_at + 1, notify: () => {} });
  await later.tick();
  row = getSend(db, retry.id)!;
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /Invalid To header/);
  assert.equal(listDrafts(db).length, 1, "a terminal failure restores the draft so it can be fixed and resent");
  await later.tick();
  assert.equal(api.calls, 2, "a failed row is never picked up again");
});

test("isTerminalSendError: auth and 4xx rejections are terminal, rate limits and 5xx are not", () => {
  assert.equal(isTerminalSendError(new AuthExpiredError()), true);
  assert.equal(isTerminalSendError(new GmailApiError(400, "bad")), true);
  assert.equal(isTerminalSendError(new GmailApiError(403, "forbidden", "insufficientPermissions")), true);
  assert.equal(isTerminalSendError(new GmailApiError(403, "slow down", "rateLimitExceeded")), false);
  assert.equal(isTerminalSendError(new GmailApiError(429, "slow down", "rateLimitExceeded")), false);
  assert.equal(isTerminalSendError(new GmailApiError(503, "backend")), false);
  assert.equal(isTerminalSendError(new Error("ECONNRESET")), false);
});

// ---- Daily 0 and Weekly 0 rollover through the scheduler ---------------------------

function clientThread(id: string, date: number, labels = ["INBOX"]) {
  return {
    id,
    historyId: "1",
    messages: [
      {
        id: `m-${id}`,
        threadId: id,
        labelIds: labels,
        snippet: "",
        internalDate: String(date),
        historyId: "1",
        payload: { mimeType: "text/plain", headers: [{ name: "From", value: "dana@northwind.example" }, { name: "To", value: "you@example.com" }, { name: "Subject", value: id }, { name: "Message-ID", value: `<${id}@x>` }] },
      },
    ],
  };
}

const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime();
const HOUR = 3_600_000;

test("activity after the night rolls Daily 0 into Weekly 0 once, whether it arrives by keystroke or by tick", async () => {
  const db = tempDb();
  const evening = local(2026, 9, 1, 22, 30);
  const dayStart = local(2026, 8, 31, 23, 0);
  setSetting(db, "dayStartAt", dayStart);
  setSetting(db, "weekStartAt", local(2026, 8, 31, 4, 0));
  setSetting(db, "lastActiveAt", evening);
  upsertThreadFromGmail(db, "arcforma", clientThread("fresh", dayStart + HOUR), { ownerAddresses: ["you@example.com"] });
  upsertClassification(db, { accountId: "arcforma", threadId: "fresh", split: "important", source: "rule" });
  upsertThreadFromGmail(db, "arcforma", clientThread("pinned", dayStart - 40 * HOUR), { ownerAddresses: ["you@example.com"] });
  setQueue(db, "arcforma", "pinned", "daily", "user", evening - HOUR);
  assert.deepEqual(queueCounts(db), { daily: 2, weekly: 0, later: 0 });

  const morning = local(2026, 9, 2, 9, 0);
  const scheduler = new Scheduler(db, { client: () => null }, { poke: () => {} }, { now: () => morning, notify: () => {} });
  const first = scheduler.noteActivity(morning);
  assert.equal(first?.newDay, true);
  assert.equal(first?.rolledDaily, 2, "both the automatic and the pinned thread roll");
  assert.equal(getSetting(db, "dayStartAt"), evening, "the day starts where last night ended");
  assert.equal(getSetting(db, "lastActiveAt"), morning);
  assert.deepEqual(queueCounts(db), { daily: 0, weekly: 2, later: 0 });

  // A tick racing the keystroke, and more activity later in the day, roll nothing further.
  scheduler.noteActivity(morning + 1000);
  await scheduler.tick();
  const later = scheduler.noteActivity(morning + 6 * HOUR);
  assert.equal(later?.newDay, false);
  assert.equal(later?.rolledDaily, 0);
  assert.deepEqual(queueCounts(db), { daily: 0, weekly: 2, later: 0 });
  assert.equal((db.prepare("SELECT in_inbox FROM threads WHERE id = 'fresh'").get() as { in_inbox: number }).in_inbox, 1, "rollover archives nothing");
});

test("the first activity after Monday 4:00 drops Weekly 0 rows older than a week to Later, and only once", async () => {
  const db = tempDb();
  const monday = local(2026, 9, 7, 8, 0);
  setSetting(db, "dayStartAt", local(2026, 9, 5, 23, 0));
  setSetting(db, "weekStartAt", local(2026, 8, 31, 4, 0));
  setSetting(db, "lastActiveAt", local(2026, 9, 6, 21, 0));
  upsertThreadFromGmail(db, "arcforma", clientThread("stale", monday - 12 * 24 * HOUR), { ownerAddresses: ["you@example.com"] });
  upsertThreadFromGmail(db, "arcforma", clientThread("recent", monday - 2 * 24 * HOUR), { ownerAddresses: ["you@example.com"] });
  setQueue(db, "arcforma", "stale", "weekly", "rollover", monday - 9 * 24 * HOUR);
  setQueue(db, "arcforma", "recent", "weekly", "rollover", monday - 2 * 24 * HOUR);
  const scheduler = new Scheduler(db, { client: () => null }, { poke: () => {} }, { now: () => monday, notify: () => {} });
  scheduler.noteActivity(monday);
  await scheduler.tick();
  const o = scheduler.noteActivity(monday);
  assert.equal(o?.newWeek, false, "already rolled");
  assert.deepEqual(queueCounts(db), { daily: 0, weekly: 1, later: 1 });
  assert.equal(getSetting(db, "weekStartAt"), local(2026, 9, 7, 4, 0));
  assert.equal(rolloverToast({ rolledDaily: 6, rolledWeekly: 0 }), "Rolled 6 into Weekly 0.");
  assert.equal(rolloverToast({ rolledDaily: 2, rolledWeekly: 3 }), "Rolled 2 into Weekly 0. Moved 3 into Later.");
  assert.equal(rolloverToast({ rolledDaily: 0, rolledWeekly: 0 }), null, "nothing moved, nothing said");
});

test("a reminder that fires puts its thread in Daily 0", async () => {
  const db = tempDb();
  const now = local(2026, 9, 2, 9, 0);
  setSetting(db, "dayStartAt", now - 10 * HOUR);
  setSetting(db, "lastActiveAt", now);
  upsertThreadFromGmail(db, "arcforma", clientThread("waiting", now - 5 * 24 * HOUR, []), { ownerAddresses: ["you@example.com"] });
  createReminder(db, { accountId: "arcforma", threadId: "waiting", lastMessageId: "m-waiting", dueAt: now - 60_000 });
  const scheduler = new Scheduler(db, { client: () => null }, { poke: () => {} }, { now: () => now, notify: () => {} });
  await scheduler.tick();
  assert.equal(getQueue(db, "arcforma", "waiting"), "daily");
  assert.equal(getQueueItem(db, "arcforma", "waiting")?.source, "reminder");
});

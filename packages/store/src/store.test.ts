import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  openStore,
  migrate,
  schemaVersion,
  upsertAccount,
  upsertThreadFromGmail,
  listThreads,
  markRead,
  star,
  archive,
  applyHistory,
  listOutbox,
  nextOutbox,
  markOutboxDone,
  markOutboxFailed,
  search,
  createSnooze,
  dueSnoozes,
  wakeSnooze,
  enqueueSend,
  releasableSends,
  cancelSend,
  markSending,
  saveBody,
  hasPendingMask,
  threadLabelIds,
  getThread,
  listThreadMessages,
  threadCounts,
  createReminder,
  dueReminders,
  hasNewerInbound,
  saveDraft,
  getDraft,
  listDrafts,
  setDraftMirror,
  findDraftByGmailId,
  findDraftByGmailMessageId,
  knownGmailMessageIds,
  upsertGmailDraft,
  listMirroredDrafts,
  enqueueDraftUpsert,
  pendingDraftUpsert,
  hasOpenDraftUpsert,
  dropPendingDraftUpserts,
  markOutboxInflight,
  queuedGmailDraftIds,
  type GmailThreadInput,
} from "./index.js";

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-store-"));
  const db = openStore(path.join(dir, "mail.db"));
  return { db, dir };
}

function thread(id: string, msgs: Array<{ id: string; from: string; to?: string; subject: string; date: number; labels: string[]; snippet?: string }>): GmailThreadInput {
  return {
    id,
    historyId: "100",
    messages: msgs.map((m) => ({
      id: m.id,
      threadId: id,
      labelIds: m.labels,
      snippet: m.snippet ?? "",
      internalDate: String(m.date),
      historyId: "100",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: m.from },
          { name: "To", value: m.to ?? "Oliver Korzen <you@example.com>" },
          { name: "Subject", value: m.subject },
          { name: "Message-ID", value: `<${m.id}@example.com>` },
        ],
      },
    })),
  };
}

const T0 = Date.UTC(2026, 7, 30, 12, 0, 0);

function seed(db: ReturnType<typeof openStore>) {
  upsertAccount(db, { id: "arcforma", email: "you@example.com", consent: "internal" });
  upsertAccount(db, { id: "personal", email: "you@gmail.com", consent: "external" });
  upsertThreadFromGmail(db, "arcforma", thread("t1", [
    { id: "m1", from: "Maya Glenn <maya@arcforma.ai>", subject: "Invoice for August", date: T0, labels: ["INBOX", "UNREAD"], snippet: "Attached is the invoice for the August coaching block." },
  ]), { ownerAddresses: ["you@example.com"] });
  upsertThreadFromGmail(db, "arcforma", thread("t2", [
    { id: "m2", from: "billing@render.com", subject: "Your receipt", date: T0 - 3_600_000, labels: ["INBOX"], snippet: "Payment received." },
    { id: "m3", from: "Oliver Korzen <you@example.com>", to: "billing@render.com", subject: "Re: Your receipt", date: T0 - 1_800_000, labels: ["SENT"], snippet: "Thanks." },
  ]), { ownerAddresses: ["you@example.com"] });
  upsertThreadFromGmail(db, "arcforma", thread("t3", [
    { id: "m4", from: "news@example.com", subject: "Archived already", date: T0 - 7_200_000, labels: [], snippet: "Old news." },
  ]));
  upsertThreadFromGmail(db, "personal", thread("p1", [
    { id: "m5", from: "friend@example.com", subject: "Weekend plans", date: T0 - 600_000, labels: ["INBOX", "UNREAD"], snippet: "Are you around Saturday?" },
  ]));
}

test("migrate is idempotent and records the schema version", () => {
  const { db } = tempDb();
  assert.equal(schemaVersion(db), 13);
  migrate(db);
  assert.equal(schemaVersion(db), 13);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
  for (const t of ["accounts", "threads", "messages", "message_bodies", "labels", "thread_labels", "thread_labels_pending", "categories", "classifications", "corrections", "snoozes", "reminders", "send_queue", "snippets", "summaries", "outbox", "contacts", "calendar_events", "messages_fts", "drafts", "settings", "reply_options", "saved_searches", "thread_unsubscribes", "attachment_files", "orphan_attachments"]) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  const cols = (db.prepare("PRAGMA table_info(send_queue)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes("tracking_token"));
  const msgCols = (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(msgCols.includes("fts_id"), "schema 3 adds the stable FTS key");
  const cats = (db.prepare("SELECT id FROM categories WHERE kind = 'builtin' ORDER BY position").all() as Array<{ id: string }>).map((c) => c.id);
  assert.deepEqual(cats, ["newsletters", "promotions", "jobs", "calendar", "notifications", "receipts"]);
});

test("a schema 10 store gains the Promotions and Jobs categories in their sidebar order", () => {
  const { db } = tempDb();
  // Roll back to the four-type world an existing store was left in.
  db.exec("DELETE FROM categories WHERE id IN ('promotions', 'jobs'); DELETE FROM schema_version WHERE version >= 11");
  db.exec("UPDATE categories SET position = 2 WHERE id = 'calendar'; UPDATE categories SET position = 3 WHERE id = 'notifications'; UPDATE categories SET position = 4 WHERE id = 'receipts'");
  assert.equal(schemaVersion(db), 10);
  migrate(db);
  const cats = db.prepare("SELECT id, name, gmail_label FROM categories WHERE kind = 'builtin' ORDER BY position").all() as Array<{ id: string; name: string; gmail_label: string }>;
  assert.deepEqual(cats.map((c) => c.id), ["newsletters", "promotions", "jobs", "calendar", "notifications", "receipts"]);
  assert.deepEqual(cats.filter((c) => c.id === "promotions" || c.id === "jobs").map((c) => [c.name, c.gmail_label]), [["Promotions", "Arcforma/Promotions"], ["Jobs", "Arcforma/Jobs"]]);
  migrate(db);
  assert.equal(schemaVersion(db), 13, "idempotent");
});

test("upsert threads and list the unified inbox newest first", () => {
  const { db } = tempDb();
  seed(db);
  const page = listThreads(db, { view: "inbox" });
  assert.deepEqual(page.rows.map((r) => `${r.account_id}:${r.id}`), ["arcforma:t1", "personal:p1", "arcforma:t2"]);
  assert.equal(page.rows[0]!.unread, 1);
  assert.equal(page.rows[2]!.unread, 0);
  assert.equal(page.rows[2]!.message_count, 2);
  assert.equal(page.nextCursor, null);
  const messages = listThreadMessages(db, "arcforma", "t2");
  assert.equal(messages[1]!.direction, "out");
  assert.equal(messages[0]!.sender_type, "role-address");
  assert.deepEqual(threadLabelIds(db, "arcforma", "t2"), ["INBOX", "SENT"]);
  const scoped = listThreads(db, { view: "inbox", accountIds: ["personal"] });
  assert.deepEqual(scoped.rows.map((r) => r.id), ["p1"]);
  assert.deepEqual(threadCounts(db), { inbox: 3, unread: 2, snoozed: 0, daily: 0, weekly: 0, later: 0, clearedDaily: 0, clearedWeekly: 0 });
});

test("cursor pagination walks the whole list without repeats", () => {
  const { db } = tempDb();
  seed(db);
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 5; i++) {
    const page = listThreads(db, { view: "all", limit: 2, cursor });
    ids.push(...page.rows.map((r) => `${r.account_id}:${r.id}`));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(ids, ["arcforma:t1", "personal:p1", "arcforma:t2", "arcforma:t3"]);
});

test("local mutations write first and queue outbox rows in order", () => {
  const { db } = tempDb();
  seed(db);
  const a = markRead(db, "arcforma", "t1");
  const b = star(db, "arcforma", "t1");
  const c = archive(db, "arcforma", "t1");
  const t1 = getThread(db, "arcforma", "t1")!;
  assert.equal(t1.unread, 0);
  assert.equal(t1.starred, 1);
  assert.equal(t1.in_inbox, 0);
  assert.equal(listThreads(db, { view: "inbox", accountIds: ["arcforma"] }).rows.map((r) => r.id).includes("t1"), false);
  const rows = listOutbox(db, "arcforma", "pending");
  assert.deepEqual(rows.map((r) => r.id), [a, b, c]);
  assert.deepEqual(JSON.parse(rows[2]!.payload_json), { threadId: "t1", addLabelIds: [], removeLabelIds: ["INBOX"] });
  assert.equal(nextOutbox(db, "arcforma")!.id, a);
  markOutboxDone(db, a);
  assert.equal(nextOutbox(db, "arcforma")!.id, b);
  markOutboxFailed(db, b, "429", Date.now() + 60_000);
  assert.equal(nextOutbox(db, "arcforma", Date.now()), null, "a retrying row blocks the rows behind it so per-account order holds");
  assert.equal(nextOutbox(db, "arcforma", Date.now() + 61_000)!.id, b, "the retrying row goes first once its time has passed");
  markOutboxDone(db, b);
  assert.equal(nextOutbox(db, "arcforma", Date.now())!.id, c);
});

test("a trashed message never hides its thread or counts as unread; a fully trashed thread does", () => {
  const { db } = tempDb();
  seed(db);
  // Gmail web trashes one reply: that message loses INBOX and gains TRASH, the other stays.
  applyHistory(db, "arcforma", [
    { type: "labelAdded", historyId: "201", messageId: "m3", threadId: "t2", changedLabelIds: ["TRASH", "UNREAD"] },
    { type: "labelRemoved", historyId: "202", messageId: "m3", threadId: "t2", changedLabelIds: ["INBOX"] },
  ]);
  const t2 = getThread(db, "arcforma", "t2")!;
  assert.equal(t2.in_inbox, 1, "the live message keeps the thread in the inbox");
  assert.equal(t2.unread, 0, "UNREAD on a trashed message does not make the thread unread");
  assert.ok(listThreads(db, { view: "inbox" }).rows.some((r) => r.id === "t2"), "the thread stays listed");
  assert.equal(threadLabelIds(db, "arcforma", "t2").includes("TRASH"), false, "TRASH is thread-level only when every message has it");
  applyHistory(db, "arcforma", [
    { type: "labelAdded", historyId: "203", messageId: "m2", threadId: "t2", changedLabelIds: ["TRASH"] },
    { type: "labelRemoved", historyId: "204", messageId: "m2", threadId: "t2", changedLabelIds: ["INBOX"] },
  ]);
  assert.ok(threadLabelIds(db, "arcforma", "t2").includes("TRASH"));
  assert.equal(listThreads(db, { view: "all" }).rows.some((r) => r.id === "t2"), false, "a fully trashed thread leaves every list");
  // Spam is excluded from the counts the same way trash is.
  applyHistory(db, "arcforma", [{ type: "labelAdded", historyId: "205", messageId: "m1", threadId: "t1", changedLabelIds: ["SPAM"] }]);
  assert.deepEqual(threadCounts(db), { inbox: 1, unread: 1, snoozed: 0, daily: 0, weekly: 0, later: 0, clearedDaily: 0, clearedWeekly: 0 });
});

test("the inbox list query walks the inbox index rather than scanning threads", () => {
  const { db } = tempDb();
  seed(db);
  const sql = `EXPLAIN QUERY PLAN SELECT t.*, c.split FROM threads t
    LEFT JOIN classifications c ON c.account_id = t.account_id AND c.thread_id = t.id
    WHERE NOT EXISTS (SELECT 1 FROM thread_labels tl WHERE tl.account_id = t.account_id AND tl.thread_id = t.id AND tl.label_id = 'TRASH')
      AND t.in_inbox = 1 AND t.account_id IN (?, ?)
    ORDER BY t.sort_at DESC, t.account_id, t.id LIMIT ?`;
  const plan = (db.prepare(sql).all("arcforma", "personal", 50) as Array<{ detail: string }>).map((r) => r.detail);
  assert.ok(plan.some((d) => /SEARCH t USING INDEX threads_inbox/.test(d)), plan.join(" | "));
  assert.equal(plan.some((d) => /SCAN t\b/.test(d)), false, plan.join(" | "));
});

test("deleting an account clears its FTS rows and a refetch that drops a message drops it from search", async () => {
  const { db } = tempDb();
  seed(db);
  const { deleteAccount } = await import("./index.js");
  assert.deepEqual(search(db, "weekend").map((h) => h.row.id), ["p1"]);
  deleteAccount(db, "personal");
  assert.equal(search(db, "weekend").length, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE account_id = 'personal'").get() as { n: number }).n, 0);
  // Gmail's thread response no longer lists m3: the store drops it, and so does search.
  assert.deepEqual(search(db, "thanks").map((h) => h.messageId), ["m3"]);
  upsertThreadFromGmail(db, "arcforma", thread("t2", [{ id: "m2", from: "billing@render.com", subject: "Your receipt", date: T0 - 3_600_000, labels: ["INBOX"], snippet: "Payment received." }]));
  assert.equal(search(db, "thanks").length, 0);
  assert.equal(listThreadMessages(db, "arcforma", "t2").length, 1);
});

test("sends interrupted by a crash fail visibly instead of going out twice", async () => {
  const { db } = tempDb();
  seed(db);
  const { failInterruptedSends, getSend } = await import("./index.js");
  const a = enqueueSend(db, { accountId: "arcforma", rawMime: "A", sendAt: T0, undoUntil: T0, meta: { draft: { subject: "A" } } });
  const b = enqueueSend(db, { accountId: "arcforma", rawMime: "B", sendAt: T0, undoUntil: T0 });
  assert.equal(markSending(db, a.id), true);
  const interrupted = failInterruptedSends(db, T0 + 5000);
  assert.deepEqual(interrupted.map((r) => r.id), [a.id]);
  assert.equal(getSend(db, a.id)!.status, "failed");
  assert.match(getSend(db, a.id)!.error ?? "", /Interrupted/);
  assert.equal(getSend(db, b.id)!.status, "queued", "queued rows are untouched");
  assert.deepEqual(releasableSends(db, T0 + 5000).map((r) => r.id), [b.id], "the failed row is never released again");
});

test("history replay: adds, deletes, label flips, and the pending mask", () => {
  const { db } = tempDb();
  seed(db);
  const outboxId = archive(db, "arcforma", "t2");
  assert.ok(hasPendingMask(db, "arcforma", "t2"));
  const r1 = applyHistory(db, "arcforma", [
    { type: "labelAdded", historyId: "101", messageId: "m2", threadId: "t2", changedLabelIds: ["INBOX"] },
    { type: "messageAdded", historyId: "102", messageId: "m9", threadId: "t9", labelIds: ["INBOX", "UNREAD"] },
    { type: "labelRemoved", historyId: "103", messageId: "m4", threadId: "t3", changedLabelIds: ["UNREAD"] },
    { type: "labelAdded", historyId: "104", messageId: "m4", threadId: "t3", changedLabelIds: ["INBOX", "STARRED"] },
    { type: "messageDeleted", historyId: "105", messageId: "m5", threadId: "p1" },
  ]);
  assert.equal(r1.masked, 1, "the archived thread ignores the stale INBOX add");
  assert.equal(getThread(db, "arcforma", "t2")!.in_inbox, 0);
  assert.deepEqual(r1.threadsToFetch, ["t9"]);
  assert.equal(r1.lastHistoryId, "105");
  const t3 = getThread(db, "arcforma", "t3")!;
  assert.equal(t3.in_inbox, 1);
  assert.equal(t3.starred, 1);
  assert.equal(getThread(db, "arcforma", "p1"), null, "deleting the only message removes the thread");
  markOutboxDone(db, outboxId);
  assert.equal(hasPendingMask(db, "arcforma", "t2"), false);
  const r2 = applyHistory(db, "arcforma", [{ type: "labelAdded", historyId: "106", messageId: "m2", threadId: "t2", changedLabelIds: ["INBOX"] }]);
  assert.equal(r2.masked, 0);
  assert.equal(getThread(db, "arcforma", "t2")!.in_inbox, 1, "after the ack, Gmail's view wins again");
});

function ftsRows(db: ReturnType<typeof openStore>): Array<{ rowid: number; message_id: string }> {
  return db.prepare("SELECT rowid, message_id FROM messages_fts ORDER BY rowid").all() as Array<{ rowid: number; message_id: string }>;
}

test("the FTS index survives VACUUM: inserts, deletes, a vacuum, then re-indexing still leaves one row per message and the right hits", () => {
  const { db } = tempDb();
  seed(db);
  saveBody(db, "arcforma", "m2", { html: null, text: "The invoice for the quarterly render bill.", attachments: [] });
  // Drop a message from the middle so the implicit rowids have a hole for VACUUM to close.
  upsertThreadFromGmail(db, "arcforma", thread("t2", [{ id: "m3", from: "Oliver Korzen <you@example.com>", to: "billing@render.com", subject: "Re: Your receipt", date: T0 - 1_800_000, labels: ["SENT"], snippet: "Thanks." }]), { ownerAddresses: ["you@example.com"] });
  assert.equal(search(db, "quarterly").length, 0, "the dropped message left the index");
  const before = db.prepare("SELECT id, rowid, fts_id FROM messages ORDER BY id").all() as Array<{ id: string; rowid: number; fts_id: number }>;
  db.exec("VACUUM");
  const after = db.prepare("SELECT id, rowid, fts_id FROM messages ORDER BY id").all() as Array<{ id: string; rowid: number; fts_id: number }>;
  assert.deepEqual(after.map((r) => r.fts_id), before.map((r) => r.fts_id), "fts_id is untouched by VACUUM");
  // Re-index every message the way a body fetch does, then check the index is exactly one row per message.
  for (const m of after) saveBody(db, m.id === "m5" ? "personal" : "arcforma", m.id, { text: `Body of ${m.id} with the word vacuumproof`, attachments: [] });
  const rows = ftsRows(db);
  assert.equal(rows.length, after.length, "one FTS row per message, no orphans, no duplicates");
  assert.deepEqual(rows.map((r) => r.rowid), after.map((r) => r.fts_id).sort((a, b) => a - b));
  assert.deepEqual(new Set(search(db, "vacuumproof").map((h) => h.messageId)), new Set(after.map((m) => m.id)));
  assert.deepEqual(search(db, "invoice").map((h) => h.row.id), ["t1"]);
  assert.deepEqual(search(db, "weekend").map((h) => h.messageId), ["m5"]);
  // A brand-new message after the vacuum gets a key past every existing one.
  upsertThreadFromGmail(db, "arcforma", thread("t7", [{ id: "m8", from: "new@example.com", subject: "Arrived afterwards", date: T0 + 1, labels: ["INBOX"] }]));
  const fresh = db.prepare("SELECT fts_id FROM messages WHERE id = 'm8'").get() as { fts_id: number };
  assert.ok(fresh.fts_id > Math.max(...after.map((r) => r.fts_id)));
  assert.deepEqual(search(db, "afterwards").map((h) => h.messageId), ["m8"]);
});

test("a schema 2 store gains fts_id and a rebuilt index on the way to schema 3", () => {
  const { db } = tempDb();
  seed(db);
  saveBody(db, "arcforma", "m4", { text: "quarterly numbers", attachments: [] });
  // Roll the store back to the version 2 shape: no fts_id column, index keyed by rowid, version row gone.
  db.exec("DROP INDEX messages_fts_id");
  db.exec("ALTER TABLE messages DROP COLUMN fts_id");
  db.exec("DELETE FROM schema_version WHERE version >= 3");
  assert.equal(schemaVersion(db), 2);
  migrate(db);
  assert.equal(schemaVersion(db), 13);
  const rows = db.prepare("SELECT id, rowid, fts_id FROM messages").all() as Array<{ id: string; rowid: number; fts_id: number }>;
  assert.ok(rows.length > 0);
  for (const r of rows) assert.equal(r.fts_id, r.rowid, "existing rows keep the rowid the index already used");
  assert.equal(ftsRows(db).length, rows.length);
  assert.deepEqual(search(db, "quarterly").map((h) => h.messageId), ["m4"]);
  assert.deepEqual(search(db, "invoice").map((h) => h.row.id), ["t1"]);
});

test("FTS5 search finds subject, sender, and fetched body text with prefix matching", () => {
  const { db } = tempDb();
  seed(db);
  assert.deepEqual(search(db, "invoice").map((h) => h.row.id), ["t1"]);
  assert.deepEqual(search(db, "inv").map((h) => h.row.id), ["t1"]);
  assert.deepEqual(search(db, "render").map((h) => h.row.id), ["t2"]);
  assert.equal(search(db, "quarterly").length, 0);
  saveBody(db, "arcforma", "m4", { html: "<p>The <b>quarterly</b> numbers are in.</p>", text: null, attachments: [] });
  const hits = search(db, "quarterly numbers");
  assert.deepEqual(hits.map((h) => h.row.id), ["t3"]);
  assert.match(hits[0]!.excerpt, /quarterly/);
  assert.equal(search(db, "invoice", { accountIds: ["personal"] }).length, 0);
  assert.deepEqual(search(db, '"invoice').map((h) => h.row.id), ["t1"], "stray quotes are stripped rather than breaking the query");
});

test("snooze hides a thread, wakes on time, and returns it to the top", () => {
  const { db } = tempDb();
  seed(db);
  const wakeAt = T0 + 86_400_000;
  const s = createSnooze(db, { accountId: "arcforma", threadId: "t2", wakeAt });
  assert.equal(listThreads(db, { view: "inbox" }).rows.some((r) => r.id === "t2"), false);
  assert.deepEqual(listThreads(db, { view: "snoozed" }).rows.map((r) => r.id), ["t2"]);
  assert.equal(listThreads(db, { view: "snoozed" }).rows[0]!.wake_at, wakeAt);
  assert.equal(dueSnoozes(db, wakeAt - 1).length, 0);
  assert.equal(dueSnoozes(db, wakeAt).length, 1);
  const snoozeOutbox = listOutbox(db, "arcforma", "pending").at(-1)!;
  assert.deepEqual(JSON.parse(snoozeOutbox.payload_json).addLabelNames, ["Arcforma/Snoozed"]);
  wakeSnooze(db, s.id, wakeAt);
  const inbox = listThreads(db, { view: "inbox" });
  assert.equal(inbox.rows[0]!.id, "t2");
  assert.ok(inbox.rows[0]!.sort_at >= wakeAt);
});

test("reminders fire only when nothing newer has arrived", () => {
  const { db } = tempDb();
  seed(db);
  const r = createReminder(db, { accountId: "arcforma", threadId: "t2", lastMessageId: "m3", dueAt: T0 + 1000 });
  assert.equal(dueReminders(db, T0).length, 0);
  assert.equal(dueReminders(db, T0 + 1000)[0]!.id, r.id);
  assert.equal(hasNewerInbound(db, "arcforma", "t2", "m3"), false);
  upsertThreadFromGmail(db, "arcforma", thread("t2", [
    { id: "m2", from: "billing@render.com", subject: "Your receipt", date: T0 - 3_600_000, labels: ["INBOX"] },
    { id: "m3", from: "Oliver Korzen <you@example.com>", subject: "Re: Your receipt", date: T0 - 1_800_000, labels: ["SENT"] },
    { id: "m6", from: "billing@render.com", subject: "Re: Your receipt", date: T0 + 500, labels: ["INBOX", "UNREAD"] },
  ]), { ownerAddresses: ["you@example.com"] });
  assert.equal(hasNewerInbound(db, "arcforma", "t2", "m3"), true);
});

test("send queue releases after send_at and cancels only while queued", () => {
  const { db } = tempDb();
  seed(db);
  const row = enqueueSend(db, { accountId: "arcforma", threadId: "t1", rawMime: "RAW", sendAt: T0 + 10_000, undoUntil: T0 + 10_000 });
  assert.equal(releasableSends(db, T0).length, 0);
  assert.equal(releasableSends(db, T0 + 10_000).length, 1);
  assert.equal(cancelSend(db, row.id), true);
  assert.equal(releasableSends(db, T0 + 10_000).length, 0);
  const later = enqueueSend(db, { accountId: "arcforma", rawMime: "RAW2", sendAt: T0, undoUntil: T0 });
  assert.equal(markSending(db, later.id), true);
  assert.equal(cancelSend(db, later.id), false, "once sending, undo is gone");
});

test("drafts, settings, reply cache, and the no-reply eyebrow", async () => {
  const { db } = tempDb();
  seed(db);
  const { saveDraft, getDraft, listDrafts, deleteDraft, getSetting, setSetting, undoWindowMs, getReplyOptions, setReplyOptions, repliedDomains, nearestCorrections, addCorrection, resolveReminder } = await import("./index.js");
  const id = saveDraft(db, { accountId: "arcforma", threadId: "t1", mode: "reply", to: [{ email: "maya@arcforma.ai", name: "Maya Glenn" }], subject: "Re: Invoice for August", bodyHtml: "<p>On it.</p>" });
  assert.equal(getDraft(db, id)!.subject, "Re: Invoice for August");
  saveDraft(db, { id, accountId: "arcforma", threadId: "t1", mode: "reply", to: [], subject: "Re: Invoice for August", bodyHtml: "<p>On it today.</p>" });
  assert.equal(listDrafts(db).length, 1);
  assert.equal(getDraft(db, id)!.body_html, "<p>On it today.</p>");
  deleteDraft(db, id);
  assert.equal(getDraft(db, id), null);

  assert.equal(getSetting(db, "undoWindowSec"), 10);
  assert.equal(undoWindowMs(db), 10_000);
  setSetting(db, "undoWindowSec", 25);
  assert.equal(undoWindowMs(db), 25_000);
  setSetting(db, "autoDraft", true);
  assert.equal(getSetting(db, "autoDraft"), true);

  assert.equal(getReplyOptions(db, "arcforma", "m1"), null);
  setReplyOptions(db, "arcforma", "m1", ["Yes.", "Not now.", "Send details."]);
  assert.deepEqual(getReplyOptions(db, "arcforma", "m1"), ["Yes.", "Not now.", "Send details."]);

  assert.ok(repliedDomains(db).has("render.com"), "Oliver replied to billing@render.com in the seed");
  assert.equal(repliedDomains(db).has("substack.com"), false);

  addCorrection(db, { accountId: "arcforma", threadId: "t3", from: { split: "other" }, to: { split: "important" }, excerpt: "From: news@example.com Subject: Archived already Old news." });
  addCorrection(db, { accountId: "arcforma", threadId: "t1", from: { split: "other" }, to: { split: "important" }, excerpt: "From: maya@arcforma.ai Subject: Invoice for August Attached is the invoice." });
  const near = nearestCorrections(db, "From: maya@arcforma.ai Subject: Re: Invoice for August Thanks for the invoice.", 1);
  assert.equal(near[0]!.thread_id, "t1");

  const r = createReminder(db, { accountId: "arcforma", threadId: "t2", lastMessageId: "m3", dueAt: T0 + 1000 });
  assert.equal(listThreads(db, { view: "all", accountIds: ["arcforma"] }).rows.find((x) => x.id === "t2")!.no_reply_by, null);
  resolveReminder(db, r.id, "fired", T0 + 1000);
  assert.equal(listThreads(db, { view: "all", accountIds: ["arcforma"] }).rows.find((x) => x.id === "t2")!.no_reply_by, T0 + 1000);
});

test("a thread refetch while a local change is still pending keeps the local change", () => {
  const { db } = tempDb();
  seed(db);
  const outboxId = archive(db, "arcforma", "t2");
  // A new reply arrives: Gmail's thread still shows INBOX on every message because the archive has not drained.
  upsertThreadFromGmail(db, "arcforma", thread("t2", [
    { id: "m2", from: "billing@render.com", subject: "Your receipt", date: T0 - 3_600_000, labels: ["INBOX"] },
    { id: "m3", from: "Oliver Korzen <you@example.com>", subject: "Re: Your receipt", date: T0 - 1_800_000, labels: ["SENT", "INBOX"] },
    { id: "m7", from: "billing@render.com", subject: "Re: Your receipt", date: T0 + 100, labels: ["INBOX", "UNREAD"] },
  ]), { ownerAddresses: ["you@example.com"] });
  const t2 = getThread(db, "arcforma", "t2")!;
  assert.equal(t2.message_count, 3, "the new reply landed");
  assert.equal(t2.in_inbox, 0, "the pending archive still masks INBOX");
  assert.equal(t2.unread, 1, "labels the mask does not touch come through");
  markOutboxDone(db, outboxId);
  upsertThreadFromGmail(db, "arcforma", thread("t2", [
    { id: "m7", from: "billing@render.com", subject: "Re: Your receipt", date: T0 + 100, labels: ["INBOX", "UNREAD"] },
  ]));
  assert.equal(getThread(db, "arcforma", "t2")!.in_inbox, 1, "after the ack Gmail's view wins again");
});

test("decodeEntities turns Gmail's escaped snippets back into text", async () => {
  const { decodeEntities } = await import("./mail-headers.js");
  assert.equal(decodeEntities("you&#39;ve &amp; me &lt;3 &quot;hi&quot; &#x2014; &nbsp;x &unknown;"), "you've & me <3 \"hi\" —  x &unknown;");
});

test("a schema 6 drafts table gains the Gmail mirror columns on the way to schema 7, with old rows counting as edited when they were saved", () => {
  const { db } = tempDb();
  // Roll drafts back to the version 2 shape and forget version 7 was applied.
  db.exec(`DROP TABLE drafts;
    CREATE TABLE drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, thread_id TEXT, mode TEXT NOT NULL DEFAULT 'new',
      to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]', bcc_json TEXT NOT NULL DEFAULT '[]',
      subject TEXT NOT NULL DEFAULT '', body_html TEXT NOT NULL DEFAULT '', quoted_html TEXT NOT NULL DEFAULT '',
      in_reply_to TEXT, references_header TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO drafts (account_id, subject, body_html, created_at, updated_at) VALUES ('arcforma', 'Old draft', '<p>kept</p>', 100, 200);
    DELETE FROM schema_version WHERE version >= 7;`);
  assert.equal(schemaVersion(db), 6);
  migrate(db);
  assert.equal(schemaVersion(db), 13);
  const cols = (db.prepare("PRAGMA table_info(drafts)").all() as Array<{ name: string }>).map((c) => c.name);
  for (const c of ["gmail_draft_id", "gmail_message_id", "mirror_state", "mirror_error", "mirrored_at", "origin", "local_edited_at"]) assert.ok(cols.includes(c), `missing ${c}`);
  const row = listDrafts(db)[0]!;
  assert.equal(row.subject, "Old draft");
  assert.equal(row.mirror_state, "pending", "an existing draft has not been mirrored yet");
  assert.equal(row.origin, "local");
  assert.equal(row.gmail_draft_id, null);
  assert.equal(row.local_edited_at, 200, "its last save counts as its last local edit");
  migrate(db);
  assert.equal(schemaVersion(db), 13, "idempotent");
});

test("draft rows carry their mirror state: a save marks pending, an import from Gmail is synced, ids are found both ways", () => {
  const { db } = tempDb();
  upsertAccount(db, { id: "arcforma", email: "you@example.com" });
  const id = saveDraft(db, { accountId: "arcforma", to: [], subject: "Mine", bodyHtml: "<p>x</p>" }, 1000);
  let row = getDraft(db, id)!;
  assert.equal(row.mirror_state, "pending");
  assert.equal(row.local_edited_at, 1000);
  assert.equal(setDraftMirror(db, id, { gmailDraftId: "d1", gmailMessageId: "m1", state: "synced", at: 1500 }), true);
  row = getDraft(db, id)!;
  assert.equal(row.mirrored_at, 1500);
  assert.equal(findDraftByGmailId(db, "arcforma", "d1")?.id, id);
  assert.equal(findDraftByGmailMessageId(db, "arcforma", "m1")?.id, id);
  assert.deepEqual([...knownGmailMessageIds(db, "arcforma")], ["m1"]);
  saveDraft(db, { id, accountId: "arcforma", to: [], subject: "Mine again", bodyHtml: "<p>y</p>" }, 2000);
  row = getDraft(db, id)!;
  assert.equal(row.mirror_state, "pending", "an edit needs mirroring again");
  assert.equal(row.gmail_draft_id, "d1", "and keeps its Gmail draft");
  assert.equal(setDraftMirror(db, 999, { state: "synced" }), false);

  const imported = upsertGmailDraft(db, { accountId: "arcforma", gmailDraftId: "d2", gmailMessageId: "m2", threadId: null, mode: "new", to: [], cc: [], bcc: [], subject: "Theirs", bodyHtml: "<p>z</p>", quotedHtml: "", inReplyTo: null, references: null }, 3000);
  row = getDraft(db, imported)!;
  assert.equal(row.origin, "gmail");
  assert.equal(row.mirror_state, "synced");
  assert.equal(row.local_edited_at, null);
  const again = upsertGmailDraft(db, { accountId: "arcforma", gmailDraftId: "d2", gmailMessageId: "m3", threadId: null, mode: "new", to: [], cc: [], bcc: [], subject: "Theirs, edited", bodyHtml: "<p>zz</p>", quotedHtml: "", inReplyTo: null, references: null }, 4000);
  assert.equal(again, imported, "the same Gmail draft updates its row in place");
  assert.equal(getDraft(db, imported)!.gmail_message_id, "m3");
  assert.deepEqual(listMirroredDrafts(db, "arcforma").map((d) => d.gmail_draft_id), ["d1", "d2"]);

  // Outbox coalescing for draft upserts.
  const a = enqueueDraftUpsert(db, "arcforma", { draftId: id, raw: "v1" });
  const b = enqueueDraftUpsert(db, "arcforma", { draftId: id, raw: "v2" });
  assert.equal(a, b, "a pending upsert for the same draft is replaced");
  assert.equal(JSON.parse(pendingDraftUpsert(db, id)!.payload_json).raw, "v2");
  assert.equal(hasOpenDraftUpsert(db, id), true);
  markOutboxInflight(db, a);
  const c = enqueueDraftUpsert(db, "arcforma", { draftId: id, raw: "v3" });
  assert.notEqual(c, a, "an inflight row is not touched; the edit waits behind it");
  assert.equal(dropPendingDraftUpserts(db, id), 1);
  assert.equal(hasOpenDraftUpsert(db, id), true, "the inflight one is still open");
  markOutboxDone(db, a);
  assert.equal(hasOpenDraftUpsert(db, id), false);
  enqueueSend(db, { accountId: "arcforma", rawMime: "RAW", sendAt: 1, undoUntil: 1, meta: { gmailDraftId: "dQ" } });
  assert.deepEqual([...queuedGmailDraftIds(db, "arcforma")], ["dQ"]);
});

test("a DRAFT-labelled message never renders as mail or drives the thread summary", async () => {
  const { listThreadMessages, isDraftMessage, recomputeThread } = await import("./queries/messages.js");
  const db = openStore(":memory:");
  upsertAccount(db, { id: "a", email: "me@x.com", consent: "internal" });
  db.prepare(`INSERT INTO threads (account_id, id, subject, snippet, participants_json, first_message_at, last_message_at, sort_at, message_count, unread, starred, in_inbox, has_attachments, last_inbound_at, last_outbound_at, history_id, updated_at)
    VALUES ('a', 't-d', 'Hello', '', '[]', 1000, 1000, 1000, 0, 0, 0, 1, 0, NULL, NULL, NULL, 1)`).run();
  const base = { account_id: "a", thread_id: "t-d", from_email: "them@x.com", from_name: "Them", to_json: "[]", cc_json: "[]", bcc_json: "[]", subject: "Hello", snippet: "", message_id_header: null, in_reply_to: null, references_header: null, headers_json: "{}", has_attachments: 0, size_estimate: null, is_auto: 0, sender_type: "person", history_id: null };
  const ins = db.prepare(`INSERT INTO messages (account_id, id, thread_id, internal_date, fts_id, from_email, from_name, to_json, cc_json, bcc_json, subject, snippet, message_id_header, in_reply_to, references_header, label_ids_json, headers_json, has_attachments, size_estimate, is_auto, sender_type, direction, history_id, updated_at)
    VALUES (@account_id, @id, @thread_id, @internal_date, @fts_id, @from_email, @from_name, @to_json, @cc_json, @bcc_json, @subject, @snippet, @message_id_header, @in_reply_to, @references_header, @label_ids_json, @headers_json, @has_attachments, @size_estimate, @is_auto, @sender_type, @direction, @history_id, @updated_at)`);
  ins.run({ ...base, id: "m1", internal_date: 1000, fts_id: 9001, snippet: "the real mail", label_ids_json: JSON.stringify(["INBOX"]), direction: "in", updated_at: 1 });
  ins.run({ ...base, id: "m2", internal_date: 2000, fts_id: 9002, from_email: "me@x.com", from_name: "Me", snippet: "Hi George, thank you", label_ids_json: JSON.stringify(["DRAFT"]), direction: "out", updated_at: 1 });
  assert.equal(isDraftMessage({ label_ids_json: JSON.stringify(["DRAFT"]) }), true);
  assert.deepEqual(listThreadMessages(db, "a", "t-d").map((m) => m.id), ["m1"]);
  assert.deepEqual(listThreadMessages(db, "a", "t-d", { includeDrafts: true }).map((m) => m.id), ["m1", "m2"]);
  recomputeThread(db, "a", "t-d");
  const t = db.prepare("SELECT snippet, message_count, participants_json, last_message_at FROM threads WHERE id = 't-d'").get() as { snippet: string; message_count: number; participants_json: string; last_message_at: number };
  assert.equal(t.snippet, "the real mail");
  assert.equal(t.message_count, 1);
  assert.equal(t.last_message_at, 1000);
  assert.ok(!t.participants_json.includes("me@x.com"));
});

test("a thread that is nothing but a draft is not a thread: recompute drops the row, the migration repair does too, and a full refetch removes a stale draft message", async () => {
  const { recomputeThreadsWithDrafts } = await import("./db.js");
  const { getThreadListRow, trash } = await import("./queries/threads.js");
  const { db } = tempDb();
  seed(db);
  // A new message written in Gmail: history brings a one-message thread whose only message is the draft.
  const row = upsertThreadFromGmail(db, "arcforma", thread("t-draft", [{ id: "d1", from: "Oliver Korzen <you@example.com>", subject: "Half written", date: T0, labels: ["DRAFT"] }]), { ownerAddresses: ["you@example.com"] });
  assert.equal(row, null, "upsert reports no thread");
  assert.equal(getThread(db, "arcforma", "t-draft"), null, "no phantom row under All Mail");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE id = 'd1'").get()!["n"], 0, "the cascade took the draft message");
  assert.equal(listThreads(db, { view: "all", accountIds: ["arcforma"] }).rows.some((r) => r.id === "t-draft"), false);

  // The repair the schema 10 step runs: a phantom row written by the old code goes the same way.
  db.prepare("INSERT INTO threads (account_id, id, subject, updated_at) VALUES ('arcforma', 't-old', 'Old phantom', 1)").run();
  db.prepare(`INSERT INTO messages (account_id, id, thread_id, internal_date, fts_id, label_ids_json, updated_at) VALUES ('arcforma', 'd-old', 't-old', ${T0}, 9100, '["DRAFT"]', 1)`).run();
  assert.equal(recomputeThreadsWithDrafts(db) >= 1, true);
  assert.equal(getThread(db, "arcforma", "t-old"), null, "the repair removed the phantom thread");

  // A reply drafted in Gmail sits in a live thread as a DRAFT message; the thread stays, the draft is not mail.
  upsertThreadFromGmail(db, "arcforma", thread("t1", [
    { id: "m1", from: "Maya Glenn <maya@arcforma.ai>", subject: "Invoice for August", date: T0, labels: ["INBOX", "UNREAD"] },
    { id: "d2", from: "Oliver Korzen <you@example.com>", subject: "Re: Invoice for August", date: T0 + 1, labels: ["DRAFT"] },
  ]), { ownerAddresses: ["you@example.com"] });
  assert.deepEqual(listThreadMessages(db, "arcforma", "t1").map((m) => m.id), ["m1"]);
  assert.equal(getThread(db, "arcforma", "t1")!.message_count, 1);
  // Trash reaches the draft message too, the way threads.trash does in Gmail.
  trash(db, "arcforma", "t1");
  assert.ok(JSON.parse(db.prepare("SELECT label_ids_json FROM messages WHERE id = 'd2'").get()!["label_ids_json"] as string).includes("TRASH"));
  // Gmail's next full response no longer lists the draft (deleted there): the local copy goes with it.
  upsertThreadFromGmail(db, "arcforma", thread("t1", [{ id: "m1", from: "Maya Glenn <maya@arcforma.ai>", subject: "Invoice for August", date: T0, labels: ["INBOX", "UNREAD"] }]), { ownerAddresses: ["you@example.com"] });
  assert.deepEqual(listThreadMessages(db, "arcforma", "t1", { includeDrafts: true }).map((m) => m.id), ["m1"], "the stale DRAFT message left with the refetch");
  assert.ok(getThreadListRow(db, "arcforma", "t1"));
});

test("history replay is idempotent: the same batch applied twice leaves threads and message labels exactly as after the first pass", () => {
  const { db } = tempDb();
  seed(db);
  const batch: Parameters<typeof applyHistory>[2] = [
    { type: "labelRemoved", historyId: "101", messageId: "m1", threadId: "t1", changedLabelIds: ["UNREAD"] },
    { type: "labelAdded", historyId: "102", messageId: "m4", threadId: "t3", changedLabelIds: ["INBOX", "STARRED"] },
    { type: "messageAdded", historyId: "103", messageId: "m2", threadId: "t2", labelIds: ["INBOX", "IMPORTANT"] },
    { type: "messageDeleted", historyId: "104", messageId: "m3", threadId: "t2" },
    { type: "messageAdded", historyId: "105", messageId: "m9", threadId: "t9", labelIds: ["INBOX"] },
  ];
  const snapshot = () => ({
    threads: db.prepare("SELECT account_id, id, subject, snippet, message_count, unread, starred, in_inbox, last_message_at FROM threads ORDER BY account_id, id").all(),
    labels: db.prepare("SELECT account_id, id, label_ids_json FROM messages ORDER BY account_id, id").all(),
    threadLabels: db.prepare("SELECT account_id, thread_id, label_id FROM thread_labels ORDER BY account_id, thread_id, label_id").all(),
  });
  const first = applyHistory(db, "arcforma", batch);
  const after1 = snapshot();
  const second = applyHistory(db, "arcforma", batch);
  assert.deepEqual(snapshot(), after1, "a replayed page changes nothing");
  assert.deepEqual(second.threadsToFetch, first.threadsToFetch, "the unknown thread is asked for again, never invented");
  assert.equal(second.lastHistoryId, "105");
  assert.equal(getThread(db, "arcforma", "t1")!.unread, 0);
  assert.equal(getThread(db, "arcforma", "t2")!.message_count, 1, "the deleted reply stays deleted");
});

test("getThreadListRow carries the same columns as the list row for that thread, so the reading pane header sees snooze, reminder, queue, and classification", async () => {
  const { getThreadListRow } = await import("./queries/threads.js");
  const { db } = tempDb();
  seed(db);
  createSnooze(db, { accountId: "arcforma", threadId: "t2", wakeAt: T0 + 86_400_000 });
  const listed = listThreads(db, { view: "snoozed", accountIds: ["arcforma"] }).rows.find((r) => r.id === "t2")!;
  const one = getThreadListRow(db, "arcforma", "t2")!;
  assert.deepEqual(one, listed);
  assert.equal(one.wake_at, T0 + 86_400_000, "a thread far down the list still reports its snooze");
  assert.equal(getThreadListRow(db, "arcforma", "nope"), null);
});

test("the attachment cache index round trips, and deleting a message hands its file back to be unlinked", async () => {
  const { countOrphanAttachments, drainOrphanAttachments, forgetAttachmentFile, getAttachmentFile, listAttachmentFiles, recordAttachmentFile } = await import("./queries/attachments.js");
  const { deleteMessage } = await import("./queries/messages.js");
  const { db } = tempDb();
  seed(db);
  recordAttachmentFile(db, { accountId: "arcforma", messageId: "m1", attachmentKey: "1", filename: "invoice.pdf", mimeType: "application/pdf", bytes: 2048, path: "/cache/arcforma/m1/invoice.pdf" }, 500);
  recordAttachmentFile(db, { accountId: "arcforma", messageId: "m1", attachmentKey: "2", filename: "logo.png", mimeType: "image/png", bytes: 900, path: "/cache/arcforma/m1/logo.png" }, 600);

  const one = getAttachmentFile(db, "arcforma", "m1", "1")!;
  assert.equal(one.filename, "invoice.pdf");
  assert.equal(one.bytes, 2048);
  assert.equal(one.path, "/cache/arcforma/m1/invoice.pdf");
  assert.equal(one.cached_at, 500);
  assert.equal(getAttachmentFile(db, "arcforma", "m1", "9"), null, "a part that was never cached is a miss, not a throw");
  assert.equal(getAttachmentFile(db, "personal", "m1", "1"), null, "the cache is scoped by account");
  assert.deepEqual(listAttachmentFiles(db, "arcforma", "m1").map((r) => r.filename), ["invoice.pdf", "logo.png"]);

  // A second fetch of the same part replaces the row rather than adding one.
  recordAttachmentFile(db, { accountId: "arcforma", messageId: "m1", attachmentKey: "1", filename: "invoice-1.pdf", mimeType: "application/pdf", bytes: 2049, path: "/cache/arcforma/m1/invoice-1.pdf" }, 700);
  assert.equal(listAttachmentFiles(db, "arcforma", "m1").length, 2);
  assert.equal(getAttachmentFile(db, "arcforma", "m1", "1")!.filename, "invoice-1.pdf");
  drainOrphanAttachments(db);

  // Dropping a row whose file is gone from disk leaves the other one alone.
  forgetAttachmentFile(db, "arcforma", "m1", "2");
  assert.deepEqual(listAttachmentFiles(db, "arcforma", "m1").map((r) => r.attachment_key), ["1"]);
  assert.deepEqual(drainOrphanAttachments(db), ["/cache/arcforma/m1/logo.png"]);

  deleteMessage(db, "arcforma", "m1");
  assert.equal(listAttachmentFiles(db, "arcforma", "m1").length, 0, "the row goes with the message");
  assert.deepEqual(drainOrphanAttachments(db), ["/cache/arcforma/m1/invoice-1.pdf"], "and its path is queued for the file to be unlinked");
  assert.equal(countOrphanAttachments(db), 0, "a drained path is not handed out twice");
});

test("attachment files cached under a thread go when the thread does, and under an account when the account does", async () => {
  const { countOrphanAttachments, drainOrphanAttachments, recordAttachmentFile } = await import("./queries/attachments.js");
  const { db } = tempDb();
  seed(db);
  // t2 holds m2 and m3; the whole thread is removed, so its messages cascade and so must their files.
  recordAttachmentFile(db, { accountId: "arcforma", messageId: "m2", attachmentKey: "1", filename: "receipt.pdf", mimeType: "application/pdf", bytes: 10, path: "/cache/arcforma/m2/receipt.pdf" });
  recordAttachmentFile(db, { accountId: "arcforma", messageId: "m3", attachmentKey: "1", filename: "note.txt", mimeType: "text/plain", bytes: 4, path: "/cache/arcforma/m3/note.txt" });
  recordAttachmentFile(db, { accountId: "personal", messageId: "m5", attachmentKey: "1", filename: "photo.png", mimeType: "image/png", bytes: 7, path: "/cache/personal/m5/photo.png" });
  db.prepare("DELETE FROM threads WHERE account_id = ? AND id = ?").run("arcforma", "t2");
  assert.deepEqual(drainOrphanAttachments(db).sort(), ["/cache/arcforma/m2/receipt.pdf", "/cache/arcforma/m3/note.txt"]);

  db.prepare("DELETE FROM accounts WHERE id = ?").run("personal");
  assert.deepEqual(drainOrphanAttachments(db), ["/cache/personal/m5/photo.png"]);
  assert.equal(countOrphanAttachments(db), 0);
});

test("drainOrphanAttachments hands back one batch at a time", async () => {
  const { countOrphanAttachments, drainOrphanAttachments } = await import("./queries/attachments.js");
  const { db } = tempDb();
  for (let i = 0; i < 5; i++) db.prepare("INSERT INTO orphan_attachments (path, orphaned_at) VALUES (?, ?)").run(`/cache/x/${i}`, 1000 + i);
  assert.deepEqual(drainOrphanAttachments(db, 2), ["/cache/x/0", "/cache/x/1"]);
  assert.equal(countOrphanAttachments(db), 3);
  assert.deepEqual(drainOrphanAttachments(db, 10), ["/cache/x/2", "/cache/x/3", "/cache/x/4"]);
  assert.deepEqual(drainOrphanAttachments(db), [], "an empty queue is an empty list, not a throw");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archive,
  createSavedSearch,
  createSnooze,
  deleteSavedSearch,
  enqueueSend,
  getSidebarLayout,
  listSavedSearches,
  listScheduledSends,
  listThreads,
  openStore,
  savedSearchCount,
  setSidebarLayout,
  sidebarCounts,
  trash,
  updateSavedSearch,
  upsertAccount,
  upsertClassification,
  upsertThreadFromGmail,
  type Db,
  type GmailThreadInput,
  type InboxView,
} from "./index.js";

const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
const HOUR = 3_600_000;

function thread(id: string, msgs: Array<{ id: string; from: string; subject: string; date: number; labels: string[]; attachment?: boolean }>): GmailThreadInput {
  return {
    id,
    historyId: "1",
    messages: msgs.map((m) => ({
      id: m.id,
      threadId: id,
      labelIds: m.labels,
      snippet: m.subject,
      internalDate: String(m.date),
      historyId: "1",
      payload: {
        mimeType: m.attachment ? "multipart/mixed" : "text/plain",
        headers: [
          { name: "From", value: m.from },
          { name: "To", value: "Oliver Korzen <you@example.com>" },
          { name: "Subject", value: m.subject },
          { name: "Message-ID", value: `<${m.id}@example.com>` },
        ],
        parts: m.attachment ? [{ mimeType: "application/pdf", filename: "deck.pdf", body: { attachmentId: "a1", size: 100 } }] : [],
      },
    })),
  };
}

/** Six threads across two accounts: an unread one with an attachment, a plain inbox one, an archived one, a spam one, a trashed one, a snoozed one. */
function seed(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-sidebar-"));
  const db = openStore(path.join(dir, "mail.db"));
  upsertAccount(db, { id: "arcforma", email: "you@example.com" });
  upsertAccount(db, { id: "personal", email: "you@gmail.com" });
  const owners = { ownerAddresses: ["you@example.com"] };
  upsertThreadFromGmail(db, "arcforma", thread("t-deck", [{ id: "m1", from: "Dana Reyes <dana@northwind.example>", subject: "Northwind deck", date: T0, labels: ["INBOX", "UNREAD"], attachment: true }]), owners);
  upsertThreadFromGmail(db, "arcforma", thread("t-plain", [{ id: "m2", from: "Sam Ortiz <sam@lumen.example>", subject: "Lunch", date: T0 - HOUR, labels: ["INBOX"] }]), owners);
  upsertThreadFromGmail(db, "arcforma", thread("t-done", [{ id: "m3", from: "Dana Reyes <dana@northwind.example>", subject: "Northwind invoice", date: T0 - 2 * HOUR, labels: ["INBOX"] }]), owners);
  upsertThreadFromGmail(db, "arcforma", thread("t-spam", [{ id: "m4", from: "win@prizes.example", subject: "You won", date: T0 - 3 * HOUR, labels: ["SPAM"] }]), owners);
  upsertThreadFromGmail(db, "personal", thread("t-trash", [{ id: "m5", from: "shop@orders.example", subject: "Order shipped", date: T0 - 4 * HOUR, labels: ["INBOX"] }]), owners);
  upsertThreadFromGmail(db, "personal", thread("t-sleep", [{ id: "m6", from: "Kim Lee <kim@friends.example>", subject: "Dinner Friday", date: T0 - 5 * HOUR, labels: ["INBOX", "STARRED"] }]), owners);
  upsertClassification(db, { accountId: "arcforma", threadId: "t-deck", split: "important", categoryId: "clients" });
  upsertClassification(db, { accountId: "arcforma", threadId: "t-plain", split: "other", type: "newsletters" });
  upsertClassification(db, { accountId: "personal", threadId: "t-sleep", split: "important" });
  archive(db, "arcforma", "t-done");
  trash(db, "personal", "t-trash");
  createSnooze(db, { accountId: "personal", threadId: "t-sleep", wakeAt: T0 + 24 * HOUR });
  return db;
}

const ids = (db: Db, view: InboxView, accountIds?: string[]) => listThreads(db, { view, accountIds }).rows.map((r) => r.id);

test("unread, attachments, archive, spam, and trash list exactly their threads", () => {
  const db = seed();
  assert.deepEqual(ids(db, "unread"), ["t-deck"]);
  assert.deepEqual(ids(db, "attachments"), ["t-deck"]);
  assert.deepEqual(ids(db, "archive"), ["t-done"], "the snoozed thread is out of the inbox but is not archive");
  assert.deepEqual(ids(db, "spam"), ["t-spam"]);
  assert.deepEqual(ids(db, "trash"), ["t-trash"]);
  assert.deepEqual(ids(db, "inbox"), ["t-deck", "t-plain"]);
  assert.deepEqual(ids(db, "trash", ["arcforma"]), [], "account scope applies to the junk views too");
  assert.deepEqual(ids(db, "snoozed"), ["t-sleep"]);
});

test("sidebarCounts returns every row count in one call, scoped by account", () => {
  const db = seed();
  const s = createSavedSearch(db, { name: "Northwind", query: "northwind" });
  enqueueSend(db, { accountId: "arcforma", rawMime: "RAW", sendAt: T0 + 20 * HOUR, undoUntil: T0 + 20 * HOUR });
  enqueueSend(db, { accountId: "personal", rawMime: "RAW", sendAt: T0 - HOUR, undoUntil: T0 - HOUR });
  const all = sidebarCounts(db, undefined, T0);
  assert.equal(all.inbox, 2);
  assert.equal(all.unread, 1);
  assert.equal(all.attachments, 1);
  assert.equal(all.archive, 1);
  assert.equal(all.spam, 1);
  assert.equal(all.trash, 1);
  assert.equal(all.snoozed, 1);
  assert.equal(all.starred, 1, "starred counts the snoozed thread; it is still starred");
  assert.equal(all.scheduled, 1, "only sends still in the future are scheduled");
  assert.equal(all.important, 1);
  assert.equal(all.other, 1);
  assert.deepEqual(all.categories, { clients: 1, newsletters: 1 });
  assert.deepEqual(all.searches, { [String(s.id)]: 2 }, "Northwind matches the deck and the archived invoice");
  const personal = sidebarCounts(db, ["personal"], T0);
  assert.equal(personal.inbox, 0);
  assert.equal(personal.trash, 1);
  assert.equal(personal.snoozed, 1);
  assert.equal(personal.scheduled, 0);
  assert.deepEqual(personal.searches, { [String(s.id)]: 0 });
});

test("saved searches: create, rename, change the query, delete, and count through FTS", () => {
  const db = seed();
  const s = createSavedSearch(db, { name: "  Dana  ", query: "dana" });
  assert.equal(s.name, "Dana");
  assert.equal(savedSearchCount(db, s.query), 2);
  assert.equal(savedSearchCount(db, s.query, ["personal"]), 0);
  assert.equal(savedSearchCount(db, "you won"), 0, "spam never counts");
  const renamed = updateSavedSearch(db, s.id, { name: "Northwind" });
  assert.equal(renamed?.name, "Northwind");
  assert.equal(renamed?.query, "dana", "a rename keeps the query");
  const requeried = updateSavedSearch(db, s.id, { query: "lunch" });
  assert.equal(savedSearchCount(db, requeried!.query), 1);
  assert.throws(() => createSavedSearch(db, { name: "", query: "x" }), /name/);
  assert.throws(() => createSavedSearch(db, { name: "Empty", query: "   " }), /something to look for/);
  assert.equal(updateSavedSearch(db, 999, { name: "Nope" }), null);
  const second = createSavedSearch(db, { name: "Orders", query: "order" });
  assert.deepEqual(listSavedSearches(db).map((r) => r.name), ["Northwind", "Orders"], "creation order is the default order");
  assert.equal(deleteSavedSearch(db, s.id), true);
  assert.equal(deleteSavedSearch(db, s.id), false);
  assert.deepEqual(listSavedSearches(db).map((r) => r.id), [second.id]);
});

test("the scheduled list is the queued sends still in the future, soonest first", () => {
  const db = seed();
  const later = enqueueSend(db, { accountId: "arcforma", rawMime: "RAW", sendAt: T0 + 48 * HOUR, undoUntil: T0 + 48 * HOUR, meta: { draft: { subject: "Later" } } });
  const soon = enqueueSend(db, { accountId: "arcforma", rawMime: "RAW", sendAt: T0 + 2 * HOUR, undoUntil: T0 + 2 * HOUR, meta: { draft: { subject: "Soon" } } });
  enqueueSend(db, { accountId: "arcforma", rawMime: "RAW", sendAt: T0 - HOUR, undoUntil: T0 - HOUR });
  enqueueSend(db, { accountId: "personal", rawMime: "RAW", sendAt: T0 + 3 * HOUR, undoUntil: T0 + 3 * HOUR });
  assert.deepEqual(listScheduledSends(db, ["arcforma"], T0).map((r) => r.id), [soon.id, later.id]);
  assert.equal(listScheduledSends(db, undefined, T0).length, 3);
  assert.equal(listScheduledSends(db, undefined, T0 + 72 * HOUR).length, 0);
});

test("the sidebar layout round-trips through the settings table as JSON and reads null until saved", () => {
  const db = seed();
  assert.equal(getSidebarLayout(db), null);
  const layout = { version: 1, groups: [{ id: "inbox", rows: [{ id: "inbox", hidden: false }] }] };
  setSidebarLayout(db, layout);
  assert.deepEqual(getSidebarLayout(db), layout);
  setSidebarLayout(db, { ...layout, groups: [] });
  assert.deepEqual(getSidebarLayout(db), { version: 1, groups: [] });
  db.prepare("UPDATE settings SET value_json = '{not json' WHERE key = 'sidebarLayout'").run();
  assert.equal(getSidebarLayout(db), null, "a corrupt row reads as unsaved rather than failing the sidebar");
});

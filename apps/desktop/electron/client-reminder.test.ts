import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GmailClient, type Transport } from "@arcforma/gmail";
import { createCategory, enqueueSend, getReminder, listThreads, openStore, pendingReminder, setSetting, upsertAccount, upsertClassification, upsertThreadFromGmail, type Db } from "@arcforma/store";
import { applyClientReminder, sentRecipients } from "./client-reminder.js";
import { Scheduler } from "./scheduler.js";

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;

function msg(id: string, threadId: string, from: string, to: string, date: number, labels: string[]) {
  return {
    id,
    threadId,
    labelIds: labels,
    snippet: "",
    internalDate: String(date),
    historyId: "1",
    payload: { mimeType: "text/plain", headers: [{ name: "From", value: from }, { name: "To", value: to }, { name: "Subject", value: threadId }, { name: "Message-ID", value: `<${id}@x>` }] },
  };
}

function tempDb(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-clientrem-"));
  const db = openStore(path.join(dir, "mail.db"));
  upsertAccount(db, { id: "arcforma", email: "you@example.com" });
  const owners = { ownerAddresses: ["you@example.com"] };
  createCategory(db, { id: "clients", name: "Clients", prompt: "Paying clients." });
  // Dana is a client with a two-way thread; the stranger has never written.
  upsertThreadFromGmail(db, "arcforma", { id: "dana", historyId: "1", messages: [msg("d1", "dana", "Dana Reyes <dana@northwind.example>", "you@example.com", T0 - 3 * DAY, ["INBOX"]), msg("d2", "dana", "Oliver <you@example.com>", "dana@northwind.example", T0 - 2 * DAY, ["SENT"])] }, owners);
  upsertClassification(db, { accountId: "arcforma", threadId: "dana", split: "important", categoryId: "clients", source: "manual" });
  return db;
}

function clientWith(response: () => { status: number; body: unknown }) {
  const transport: Transport = async () => {
    const r = response();
    return { status: r.status, headers: { get: () => null }, text: async () => JSON.stringify(r.body) };
  };
  return new GmailClient({ accessToken: async () => "t", transport, sleep: async () => {}, maxAttempts: 1 });
}

const toDana = { accountId: "arcforma", threadId: "dana", mode: "reply" as const, to: [{ email: "dana@northwind.example", name: "Dana" }], cc: [], bcc: [], subject: "Re: dana", bodyHtml: "<p>Plan attached.</p>", quotedHtml: "" };
const toStranger = { ...toDana, threadId: null, mode: "new" as const, to: [{ email: "stranger@example.com", name: "" }], subject: "Hello" };

test("a send to a client creates one reminder due in N days; the NO REPLY BY eyebrow follows when it fires", async () => {
  const db = tempDb();
  const row = enqueueSend(db, { accountId: "arcforma", threadId: "dana", rawMime: "RAW", sendAt: T0, undoUntil: T0, meta: { draft: toDana } });
  const client = clientWith(() => ({ status: 200, body: { id: "g-sent", threadId: "dana" } }));
  const accounts = { client: () => client, ownerAddresses: () => ["you@example.com"] };
  await new Scheduler(db, accounts, { poke: () => {} }, { now: () => T0 + 1, notify: () => {} }).tick();
  const reminder = pendingReminder(db, "arcforma", "dana");
  assert.ok(reminder, "the rule made a reminder");
  assert.equal(reminder!.due_at, T0 + 1 + 3 * DAY, "three days by default");
  assert.equal(reminder!.last_message_id, "g-sent", "anchored on the message that went out");
  assert.equal(sentRecipients(row).length, 1);
  // The same send again (a second message into the thread) does not stack a second reminder.
  enqueueSend(db, { accountId: "arcforma", threadId: "dana", rawMime: "RAW", sendAt: T0 + 2, undoUntil: T0 + 2, meta: { draft: toDana } });
  await new Scheduler(db, accounts, { poke: () => {} }, { now: () => T0 + 3, notify: () => {} }).tick();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM reminders WHERE status = 'pending'").get() as { n: number }).n, 1);
  // No reply by the due date: it fires, the thread comes back with the eyebrow and goes into Daily 0.
  const toasts: string[] = [];
  const fireAt = T0 + 1 + 3 * DAY;
  const later = new Scheduler(db, accounts, { poke: () => {} }, { now: () => fireAt, notify: (title) => toasts.push(title) });
  await later.tick();
  assert.equal(getReminder(db, reminder!.id)!.status, "fired");
  assert.deepEqual(toasts, ["No reply yet"]);
  const dana = listThreads(db, { view: "all", accountIds: ["arcforma"] }).rows.find((r) => r.id === "dana")!;
  assert.equal(dana.no_reply_by, fireAt);
  assert.equal(dana.queue, "daily");
});

test("no reminder for a stranger, none when the rule is off, none for a message to oneself", async () => {
  const db = tempDb();
  const client = clientWith(() => ({ status: 200, body: { id: "g1", threadId: "new-thread" } }));
  const accounts = { client: () => client, ownerAddresses: () => ["you@example.com"] };
  enqueueSend(db, { accountId: "arcforma", threadId: null, rawMime: "RAW", sendAt: T0, undoUntil: T0, meta: { draft: toStranger } });
  await new Scheduler(db, accounts, { poke: () => {} }, { now: () => T0 + 1, notify: () => {} }).tick();
  assert.equal(pendingReminder(db, "arcforma", "new-thread"), null, "a stranger earns nothing");

  setSetting(db, "remindClientsAfterDays", 0);
  enqueueSend(db, { accountId: "arcforma", threadId: "dana", rawMime: "RAW", sendAt: T0, undoUntil: T0, meta: { draft: toDana } });
  await new Scheduler(db, accounts, { poke: () => {} }, { now: () => T0 + 1, notify: () => {} }).tick();
  assert.equal(pendingReminder(db, "arcforma", "dana"), null, "0 days turns the rule off");

  setSetting(db, "remindClientsAfterDays", 5);
  const self = applyClientReminder(db, { accountId: "arcforma", threadId: "dana", sentThreadId: "dana", sentMessageId: "g2", recipients: [{ email: "you@example.com", name: "" }], ownAddresses: ["you@example.com"], now: T0 });
  assert.equal(self, null, "a note to self is not client mail");
  const made = applyClientReminder(db, { accountId: "arcforma", threadId: null, sentThreadId: "fresh", sentMessageId: "g3", recipients: [{ email: "Dana@northwind.example", name: "" }], ownAddresses: ["you@example.com"], now: T0 });
  assert.ok(made, "a new message to a known client, on the thread Gmail assigned");
  assert.equal(made!.thread_id, "fresh");
  assert.equal(made!.due_at, T0 + 5 * DAY);
  setSetting(db, "remindScope", []);
  assert.equal(applyClientReminder(db, { accountId: "arcforma", threadId: "dana", sentThreadId: "dana", sentMessageId: "g4", recipients: [{ email: "dana@northwind.example", name: "" }], ownAddresses: [], now: T0 }), null, "an empty scope applies to nothing");
  assert.deepEqual(sentRecipients({ meta_json: JSON.stringify({ unsubscribe: { threadId: "x", to: "y" } }) }), [], "an unsubscribe request carries no draft and earns no reminder");
});

test("a reply that arrives before the due date resolves the reminder as replied instead of firing it", async () => {
  const db = tempDb();
  const client = clientWith(() => ({ status: 200, body: { id: "g-sent", threadId: "dana" } }));
  const accounts = { client: () => client, ownerAddresses: () => ["you@example.com"] };
  enqueueSend(db, { accountId: "arcforma", threadId: "dana", rawMime: "RAW", sendAt: T0, undoUntil: T0, meta: { draft: toDana } });
  await new Scheduler(db, accounts, { poke: () => {} }, { now: () => T0 + 1, notify: () => {} }).tick();
  const reminder = pendingReminder(db, "arcforma", "dana")!;
  // The sync lands the sent message, then Dana answers a day later.
  upsertThreadFromGmail(
    db,
    "arcforma",
    {
      id: "dana",
      historyId: "2",
      messages: [
        msg("d1", "dana", "Dana Reyes <dana@northwind.example>", "you@example.com", T0 - 3 * DAY, ["INBOX"]),
        msg("d2", "dana", "Oliver <you@example.com>", "dana@northwind.example", T0 - 2 * DAY, ["SENT"]),
        msg("g-sent", "dana", "Oliver <you@example.com>", "dana@northwind.example", T0 + 1, ["SENT"]),
        msg("d3", "dana", "Dana Reyes <dana@northwind.example>", "you@example.com", T0 + DAY, ["INBOX", "UNREAD"]),
      ],
    },
    { ownerAddresses: ["you@example.com"] }
  );
  const toasts: string[] = [];
  await new Scheduler(db, accounts, { poke: () => {} }, { now: () => reminder.due_at + 1, notify: (title) => toasts.push(title) }).tick();
  assert.equal(getReminder(db, reminder.id)!.status, "replied");
  assert.deepEqual(toasts, [], "nothing fires, nothing is announced");
  assert.equal(listThreads(db, { view: "all", accountIds: ["arcforma"] }).rows.find((r) => r.id === "dana")!.no_reply_by, null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore, type Db } from "./db.js";
import { addressingOf, attentionContext, attentionFactsFor, demotedSenders, excerptSender, needsYouCount, senderStats, sentToCounts, updateAttention } from "./queries/attention.js";
import { addCorrection, createCategory, upsertClassification } from "./queries/misc.js";
import { createSnooze } from "./queries/scheduler.js";
import { upsertAccount } from "./queries/accounts.js";
import { listThreads } from "./queries/threads.js";
import { sidebarCounts } from "./queries/sidebar.js";
import { setSetting } from "./queries/settings.js";
import type { GmailThreadInput, MessageRow } from "./types.js";
import { upsertThreadFromGmail } from "./queries/threads.js";

const DAY = 86_400_000;
const OWNERS = ["you@example.com"];

function tempDb(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-attention-"));
  const db = openStore(path.join(dir, "mail.db"));
  upsertAccount(db, { id: "arcforma", email: "you@example.com" });
  return db;
}

interface Msg {
  id: string;
  from: string;
  to?: string;
  cc?: string;
  subject: string;
  snippet?: string;
  daysAgo: number;
  labels?: string[];
  headers?: Record<string, string>;
}

function thread(id: string, messages: Msg[]): GmailThreadInput {
  return {
    id,
    historyId: "1",
    messages: messages.map((m) => ({
      id: m.id,
      threadId: id,
      labelIds: m.labels ?? ["INBOX"],
      snippet: m.snippet ?? "",
      internalDate: String(Date.now() - m.daysAgo * DAY),
      historyId: "1",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: m.from },
          { name: "To", value: m.to ?? "you@example.com" },
          ...(m.cc ? [{ name: "Cc", value: m.cc }] : []),
          { name: "Subject", value: m.subject },
          ...Object.entries(m.headers ?? {}).map(([name, value]) => ({ name, value })),
        ],
      },
    })),
  };
}

function put(db: Db, id: string, messages: Msg[]): void {
  upsertThreadFromGmail(db, "arcforma", thread(id, messages), { ownerAddresses: OWNERS });
}

/** A message row shaped for addressingOf, without going near the store. */
function row(to: string[], cc: string[]): MessageRow {
  return { to_json: JSON.stringify(to.map((email) => ({ email, name: "" }))), cc_json: JSON.stringify(cc.map((email) => ({ email, name: "" }))) } as MessageRow;
}

test("addressing: To alone, To with others, Cc only, and a group alias he is not named on", () => {
  const owners = new Set(OWNERS);
  assert.equal(addressingOf(row(["you@example.com"], []), owners), "to");
  assert.equal(addressingOf(row(["you@example.com", "maya@example.net"], []), owners), "to_with_others");
  assert.equal(addressingOf(row(["team@arcforma.ai"], ["you@example.com"]), owners), "cc");
  assert.equal(addressingOf(row(["jobs@arcforma.ai"], []), owners), "alias");
  assert.equal(addressingOf(row(["you@example.com"], []), owners), "to", "the match is case insensitive");
  assert.equal(addressingOf({ to_json: "not json", cc_json: "[]" } as MessageRow, owners), "alias", "a malformed list cannot address anyone");
});

test("who he has written to: counts and recency per address, and the domains behind them", () => {
  const db = tempDb();
  put(db, "t1", [
    { id: "m1", from: "dana@northwind.example", subject: "Hello", daysAgo: 9 },
    { id: "m2", from: "you@example.com", to: "dana@northwind.example", cc: "sam@harbor.example", subject: "Re: Hello", daysAgo: 8, labels: ["SENT"] },
    { id: "m3", from: "you@example.com", to: "dana@northwind.example", subject: "Re: Hello", daysAgo: 2, labels: ["SENT"] },
  ]);
  const sent = sentToCounts(db);
  assert.equal(sent.addresses.get("dana@northwind.example")?.count, 2);
  assert.equal(sent.addresses.get("sam@harbor.example")?.count, 1, "a Cc counts as writing to them");
  assert.ok(Math.abs((sent.addresses.get("dana@northwind.example")?.lastAt ?? 0) - (Date.now() - 2 * DAY)) < 5_000, "the newest message sets the recency");
  assert.ok(sent.domains.has("northwind.example"));
  assert.equal(sent.domains.has("gmail.com"), false, "freemail domains are shared, so writing to one says nothing about the next");
  db.close();
});

test("archive without reading: the share of a sender's threads that left the inbox still unread", () => {
  const db = tempDb();
  // Five threads from one shop. Four went out of the inbox unread; one was read.
  for (let i = 0; i < 4; i++) put(db, `s${i}`, [{ id: `s${i}m`, from: "shop@nordic.example", subject: `Sale ${i}`, daysAgo: 30 - i, labels: ["UNREAD"] }]);
  put(db, "s4", [{ id: "s4m", from: "shop@nordic.example", subject: "Sale 4", daysAgo: 26, labels: [] }]);
  put(db, "p1", [{ id: "p1m", from: "dana@northwind.example", subject: "Notes", daysAgo: 1, labels: ["INBOX", "UNREAD"] }]);

  const stats = senderStats(db);
  const shop = stats.get("shop@nordic.example")!;
  assert.equal(shop.threads, 5);
  assert.equal(shop.archivedUnread, 4, "four left the inbox while still unread");
  assert.equal(shop.unread, 4);
  const dana = stats.get("dana@northwind.example")!;
  assert.equal(dana.archivedUnread, 0, "a thread still in the inbox has not been archived unread");

  const ctx = attentionContext(db);
  const f = attentionFactsFor(db, "arcforma", "s0", ctx)!;
  assert.equal(f.senderThreads, 5);
  assert.equal(f.archiveWithoutReadRate, 0.8);
  assert.equal(f.neverOpened, false, "one of the five was read, so it is not never-opened");
  assert.ok(f.threadsPerWeek > 0, "volume is threads over the span the store has seen the sender");
  db.close();
});

test("a thread's facts: sender, addressing, conversation, how long it has waited, and the ask text", () => {
  const db = tempDb();
  put(db, "t1", [
    { id: "m1", from: "you@example.com", to: "dana@northwind.example", subject: "Kickoff", daysAgo: 10, labels: ["SENT"] },
    { id: "m2", from: "Dana Reyes <dana@northwind.example>", to: "you@example.com, maya@example.net", subject: "Re: Kickoff", snippet: "Can you confirm Thursday?", daysAgo: 2 },
  ]);
  const ctx = attentionContext(db);
  const f = attentionFactsFor(db, "arcforma", "t1", ctx)!;
  assert.equal(f.senderEmail, "dana@northwind.example");
  assert.equal(f.senderName, "Dana Reyes");
  assert.equal(f.senderDomain, "northwind.example");
  assert.equal(f.isOwnSender, false);
  assert.equal(f.addressing, "to_with_others");
  assert.equal(f.youAreInThread, true);
  assert.equal(f.youStartedThread, true);
  assert.equal(f.repliedCount, 1);
  assert.equal(f.repliedDomain, true);
  assert.ok(f.unansweredMs !== null && f.unansweredMs > 1.9 * DAY && f.unansweredMs < 2.1 * DAY);
  assert.match(f.askText, /Re: Kickoff/);
  assert.match(f.askText, /Can you confirm Thursday\?/);
  assert.equal(f.isBulk, false);

  // He answers: the thread stops waiting on him, and nothing else about it changes.
  put(db, "t1", [
    { id: "m1", from: "you@example.com", to: "dana@northwind.example", subject: "Kickoff", daysAgo: 10, labels: ["SENT"] },
    { id: "m2", from: "Dana Reyes <dana@northwind.example>", to: "you@example.com, maya@example.net", subject: "Re: Kickoff", snippet: "Can you confirm Thursday?", daysAgo: 2 },
    { id: "m3", from: "you@example.com", to: "dana@northwind.example", subject: "Re: Kickoff", daysAgo: 1, labels: ["SENT"] },
  ]);
  const after = attentionFactsFor(db, "arcforma", "t1", attentionContext(db))!;
  assert.equal(after.unansweredMs, null);
  assert.equal(after.senderEmail, "dana@northwind.example", "the last inbound message still decides");
  db.close();
});

test("bulk headers, automated mail, and a message from one of his own addresses", () => {
  const db = tempDb();
  put(db, "bulk", [{ id: "b1", from: "digest@weekly.example", subject: "Issue 41", daysAgo: 1, headers: { "List-Id": "<weekly.example>" } }]);
  put(db, "unsub", [{ id: "u1", from: "shop@nordic.example", subject: "Sale", daysAgo: 1, headers: { "List-Unsubscribe": "<mailto:x>" } }]);
  put(db, "prec", [{ id: "p1", from: "alerts@vault.example", subject: "Sign-in", daysAgo: 1, headers: { Precedence: "bulk" } }]);
  put(db, "auto", [{ id: "a1", from: "no-reply@render.com", subject: "Deploy succeeded", daysAgo: 1, headers: { "Auto-Submitted": "auto-generated" } }]);
  put(db, "self", [{ id: "s1", from: "you@example.com", subject: "Note to self", daysAgo: 1 }]);
  const ctx = attentionContext(db);
  assert.equal(attentionFactsFor(db, "arcforma", "bulk", ctx)!.isBulk, true);
  assert.equal(attentionFactsFor(db, "arcforma", "unsub", ctx)!.isBulk, true);
  assert.equal(attentionFactsFor(db, "arcforma", "prec", ctx)!.isBulk, true);
  assert.equal(attentionFactsFor(db, "arcforma", "auto", ctx)!.isAuto, true);
  assert.equal(attentionFactsFor(db, "arcforma", "self", ctx)!.isOwnSender, true);
  assert.equal(attentionFactsFor(db, "arcforma", "gone", ctx), null, "a thread with no messages has no facts");
  db.close();
});

test("client domains come from the remindScope categories, and the type can be passed in or read back", () => {
  const db = tempDb();
  createCategory(db, { id: "clients", name: "Clients", prompt: "Paying clients." });
  setSetting(db, "remindScope", ["Clients"]);
  put(db, "c1", [{ id: "c1m", from: "dana@northwind.example", subject: "Session", daysAgo: 3 }]);
  put(db, "c2", [{ id: "c2m", from: "sam@northwind.example", subject: "Invoice", daysAgo: 1 }]);
  upsertClassification(db, { accountId: "arcforma", threadId: "c1", split: "important", categoryId: "clients", source: "manual" });
  const ctx = attentionContext(db);
  assert.equal(ctx.clientDomains.has("northwind.example"), true);
  assert.equal(attentionFactsFor(db, "arcforma", "c2", ctx)!.isClientDomain, true, "a colleague at a client domain counts too");

  upsertClassification(db, { accountId: "arcforma", threadId: "c2", split: "other", type: "receipts", source: "rule" });
  assert.equal(attentionFactsFor(db, "arcforma", "c2", ctx)!.type, "receipts", "the stored type is read back when the caller has none");
  assert.equal(attentionFactsFor(db, "arcforma", "c2", ctx, { type: null })!.type, null, "the caller's type wins, including a deliberate null");
  db.close();
});

test("a re-file feeds the sender back out of the corrections bank", () => {
  const db = tempDb();
  assert.equal(excerptSender("From: Dana Reyes <dana@northwind.example>\nSubject: Hi\n\nbody"), "dana@northwind.example");
  assert.equal(excerptSender("From: dana@northwind.example\nSubject: Hi"), "dana@northwind.example");
  assert.equal(excerptSender("Subject: no sender line"), null);

  put(db, "t1", [{ id: "m1", from: "news@lumen.example", subject: "Weekly", daysAgo: 1 }]);
  addCorrection(db, { accountId: "arcforma", threadId: "t1", messageId: "m1", from: { split: "important" }, to: { split: "other", type: "newsletters" }, excerpt: "From: Lumen <news@lumen.example>\nSubject: Weekly\n\nbody" });
  assert.equal(demotedSenders(db).get("news@lumen.example"), 1);
  addCorrection(db, { accountId: "arcforma", threadId: "t1", messageId: "m1", from: { split: "important" }, to: { split: "other" }, excerpt: "From: Lumen <news@lumen.example>\nSubject: Weekly 2\n\nbody" });
  assert.equal(demotedSenders(db).get("news@lumen.example"), 2, "every re-file out of Important counts against the sender");
  addCorrection(db, { accountId: "arcforma", threadId: "t1", messageId: "m1", from: { split: "other" }, to: { split: "important" }, excerpt: "From: Dana <dana@northwind.example>\nSubject: Hi" });
  assert.equal(demotedSenders(db).get("dana@northwind.example"), undefined, "filing a thread into Important is not a demotion");
  assert.equal(attentionFactsFor(db, "arcforma", "t1", attentionContext(db))!.demotions, 2);
  db.close();
});

test("the Needs you view and its count list inbox threads only, awake and out of the junk", () => {
  const db = tempDb();
  const ids = ["n1", "n2", "n3", "n4", "n5"];
  for (const [i, id] of ids.entries()) put(db, id, [{ id: `${id}m`, from: `p${i}@northwind.example`, subject: `Question ${i}`, daysAgo: i + 1 }]);
  // n4 is out of the inbox; n5 is snoozed. Neither belongs in a row that promises something is waiting.
  put(db, "n4", [{ id: "n4m", from: "p3@northwind.example", subject: "Question 3", daysAgo: 4, labels: [] }]);
  createSnooze(db, { accountId: "arcforma", threadId: "n5", wakeAt: Date.now() + DAY });
  for (const id of ids) {
    upsertClassification(db, { accountId: "arcforma", threadId: id, split: "other", source: "rule" });
    updateAttention(db, { accountId: "arcforma", threadId: id, split: "important", attention: 70, band: "needs_you", reason: "Someone asked you a question" });
  }

  assert.equal(needsYouCount(db), 3, "n4 is archived and n5 is asleep");
  assert.equal(needsYouCount(db, ["arcforma"]), 3);
  assert.equal(needsYouCount(db, ["personal"]), 0, "the count honours the account filter");
  assert.equal(sidebarCounts(db).needsYou, 3);

  const page = listThreads(db, { view: "needsyou" });
  assert.deepEqual(page.rows.map((r) => r.id), ["n1", "n2", "n3"], "newest first, and nothing that is done or asleep");
  for (const r of page.rows) {
    assert.equal(r.band, "needs_you");
    assert.equal(r.attention, 70);
    assert.equal(r.attention_reason, "Someone asked you a question");
    assert.equal(r.split, "important", "the split column keeps working for everything written before the band existed");
  }

  // A re-file out of the band empties the row without touching the thread.
  updateAttention(db, { accountId: "arcforma", threadId: "n1", split: "other", attention: 0, band: "other", reason: "You filed this out of Important." });
  assert.equal(needsYouCount(db), 2);
  assert.deepEqual(listThreads(db, { view: "needsyou" }).rows.map((r) => r.id), ["n2", "n3"]);
  assert.equal(listThreads(db, { view: "inbox", split: "important" }).rows.length, 2, "the split follows the band");
  db.close();
});

test("upsertClassification carries the score, the band, and the reason, and defaults the band from the split", () => {
  const db = tempDb();
  put(db, "t1", [{ id: "m1", from: "dana@northwind.example", subject: "Hi", daysAgo: 1 }]);
  put(db, "t2", [{ id: "m2", from: "sam@harbor.example", subject: "Hi", daysAgo: 1 }]);
  upsertClassification(db, { accountId: "arcforma", threadId: "t1", split: "important", attention: 72, band: "needs_you", reason: "Dana asked a question" });
  const row1 = db.prepare("SELECT attention, band, reason FROM classifications WHERE thread_id = 't1'").get() as unknown as { attention: number; band: string; reason: string };
  assert.deepEqual({ ...row1 }, { attention: 72, band: "needs_you", reason: "Dana asked a question" });
  // A caller that has not scored the thread still leaves a band the queries can read.
  upsertClassification(db, { accountId: "arcforma", threadId: "t2", split: "important" });
  const row2 = db.prepare("SELECT attention, band, reason FROM classifications WHERE thread_id = 't2'").get() as unknown as { attention: number; band: string; reason: string | null };
  assert.deepEqual({ ...row2 }, { attention: 0, band: "important", reason: null });
  db.close();
});

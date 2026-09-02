import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enqueueSend, listScheduledSends, openStore, upsertAccount } from "@arcforma/store";
import { isScheduledThreadId, scheduledSendId, scheduledSummary, scheduledView } from "./scheduled.js";

const T0 = 1_800_000_000_000;
const sender = { email: "you@example.com", name: "Oliver Korzen" };
const draft = {
  accountId: "arcforma",
  threadId: null,
  mode: "new" as const,
  to: [{ email: "dana@northwind.example", name: "Dana Reyes" }],
  cc: [{ email: "sam@northwind.example", name: "" }],
  bcc: [],
  subject: "Session plan",
  bodyHtml: "<p>Hi Dana,</p><p>Plan attached below.</p>",
  quotedHtml: "<p>On Monday Dana wrote:</p>",
};

test("a queued send becomes a list row with the recipients, the subject, and send_at as its date", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-scheduled-"));
  const db = openStore(path.join(dir, "mail.db"));
  upsertAccount(db, { id: "arcforma", email: "you@example.com" });
  const row = enqueueSend(db, { accountId: "arcforma", rawMime: "RAW", sendAt: T0 + 3_600_000, undoUntil: T0 + 3_600_000, meta: { draft } });
  const [listed] = listScheduledSends(db, ["arcforma"], T0);
  const summary = scheduledSummary(listed!, sender);
  assert.equal(summary.id, `send:${row.id}`);
  assert.equal(summary.subject, "Session plan");
  assert.equal(summary.snippet, "Hi Dana, Plan attached below.");
  assert.deepEqual(summary.participants.map((p) => p.email), ["dana@northwind.example", "sam@northwind.example"]);
  assert.equal(summary.lastMessageAt, T0 + 3_600_000);
  assert.deepEqual(summary.scheduled, { sendId: row.id, sendAt: T0 + 3_600_000 });
  assert.equal(summary.unread, false);
  assert.equal(isScheduledThreadId(summary.id), true);
  assert.equal(scheduledSendId(summary.id), row.id);
  assert.equal(scheduledSendId("t-kickoff"), null);
  assert.equal(scheduledSendId("send:abc"), null);
});

test("the reading pane view is one outbound message carrying the body and the quote, with no pending bodies", () => {
  const row = { id: 7, account_id: "arcforma", thread_id: null, raw_mime: "RAW", meta_json: JSON.stringify({ draft }), send_at: T0, undo_until: T0, status: "queued" as const, attempts: 0, gmail_message_id: null, error: null, tracking_token: null, created_at: T0, updated_at: T0 };
  const view = scheduledView(row, sender);
  assert.equal(view.thread.id, "send:7");
  assert.equal(view.bodiesPending, false);
  assert.equal(view.messages.length, 1);
  const m = view.messages[0]!;
  assert.equal(m.direction, "out");
  assert.deepEqual(m.from, sender);
  assert.deepEqual(m.to, draft.to);
  assert.match(m.body!.html!, /Plan attached below/);
  assert.match(m.body!.html!, /gmail_quote/);
  const bare = scheduledView({ ...row, meta_json: "not json" }, sender);
  assert.equal(bare.thread.subject, "");
  assert.deepEqual(bare.thread.participants, [sender], "a row without a draft still lists under the sender");
  assert.equal(bare.messages[0]!.body!.html, "<p></p>");
});

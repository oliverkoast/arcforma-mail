import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSend, markSending, openStore, releasableSends, setSetting, updateAccount, upsertAccount } from "@arcforma/store";
import { composeHtml, queueSend, undoSend, validateDraft } from "./queue.js";
import type { ComposeDraft } from "../../shared/types.js";

function db() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-queue-"));
  const store = openStore(path.join(dir, "mail.db"));
  upsertAccount(store, { id: "arcforma", email: "you@example.com", displayName: "Oliver Korzen", consent: "internal" });
  updateAccount(store, "arcforma", { signature_html: "<div>Oliver Korzen<br>Arcforma</div>" });
  return store;
}

const draft: ComposeDraft = {
  accountId: "arcforma",
  threadId: "t1",
  mode: "reply",
  to: [{ email: "dana@northwind.example", name: "Dana" }],
  cc: [],
  bcc: [],
  subject: "Re: Kickoff",
  bodyHtml: "<p>9:00 works.</p>",
  quotedHtml: "<blockquote>Can we do 9:00?</blockquote>",
  inReplyTo: "<m-k3@fixture.example>",
  references: "<m-k1@fixture.example> <m-k3@fixture.example>",
};

test("queueSend schedules send_at at now plus the undo window and carries the signature", async () => {
  const store = db();
  const now = 1_800_000_000_000;
  const r = await queueSend(store, draft, { now });
  assert.equal(r.sendAt, now + 10_000);
  assert.equal(r.undoUntil, now + 10_000);
  const row = getSend(store, r.id)!;
  assert.equal(row.thread_id, "t1");
  assert.match(row.raw_mime, /^Subject: Re: Kickoff/m);
  assert.match(row.raw_mime, /^In-Reply-To: <m-k3@fixture.example>/m);
  assert.match(row.raw_mime, /gmail_signature/);
  assert.match(row.raw_mime, /gmail_quote/);
  assert.equal(releasableSends(store, now + 9_999).length, 0, "nothing releases inside the undo window");
  assert.equal(releasableSends(store, now + 10_000).length, 1, "the row releases when the window ends");
});

test("the undo window follows the setting and undo returns the draft while it is still queued", async () => {
  const store = db();
  setSetting(store, "undoWindowSec", 30);
  const now = 1_800_000_000_000;
  const r = await queueSend(store, draft, { now });
  assert.equal(r.sendAt, now + 30_000);
  const undone = undoSend(store, r.id);
  assert.equal(undone.cancelled, true);
  assert.equal(undone.draft?.subject, "Re: Kickoff");
  assert.equal(undone.draft?.bodyHtml, "<p>9:00 works.</p>");
  assert.equal(releasableSends(store, now + 60_000).length, 0, "a cancelled row never releases");
  const again = undoSend(store, r.id);
  assert.equal(again.cancelled, false, "undo is one-shot");
});

test("once the worker picks a row up, undo is gone", async () => {
  const store = db();
  const now = 1_800_000_000_000;
  const r = await queueSend(store, draft, { now });
  assert.equal(markSending(store, r.id), true);
  assert.deepEqual(undoSend(store, r.id), { cancelled: false, draft: null, gmailDraftId: null });
});

test("send later keeps the chosen time and stays undoable until then", async () => {
  const store = db();
  const now = 1_800_000_000_000;
  const later = now + 3 * 3_600_000;
  const r = await queueSend(store, draft, { now, sendAt: later });
  assert.equal(r.sendAt, later);
  assert.equal(r.undoUntil, later);
  assert.equal(releasableSends(store, later - 1).length, 0);
  assert.equal(releasableSends(store, later).length, 1);
  const past = await queueSend(store, draft, { now, sendAt: now - 1000 });
  assert.equal(past.sendAt, now + 10_000, "a time in the past falls back to the undo window");
});

test("validateDraft and composeHtml", () => {
  assert.throws(() => validateDraft({ ...draft, to: [] }), /at least one recipient/);
  assert.throws(() => validateDraft({ ...draft, to: [{ email: "nope", name: "" }] }), /not a valid address/);
  assert.equal(composeHtml({ bodyHtml: "<p>Hi</p>", quotedHtml: "" }), "<p>Hi</p>");
  assert.equal(composeHtml({ bodyHtml: "", quotedHtml: "<p>old</p>" }), '<p></p><br><div class="gmail_quote"><p>old</p></div>');
});

test("the queued MIME puts the signature between the body and the quote, once", async () => {
  const store = db();
  const r = await queueSend(store, draft, { now: 1_800_000_000_000 });
  const mime = getSend(store, r.id)!.raw_mime.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  const html = mime.split("Content-Type: text/html")[1]!;
  assert.equal((html.match(/class="gmail_signature"/g) ?? []).length, 1);
  assert.ok(html.indexOf("9:00 works") < html.indexOf("gmail_signature"));
  assert.ok(html.indexOf("gmail_signature") < html.indexOf("gmail_quote"));
});

test("a send-later message is dated when it goes out", async () => {
  const store = db();
  const now = Date.UTC(2026, 8, 1, 17, 0, 0);
  const later = Date.UTC(2026, 8, 2, 16, 0, 0);
  const r = await queueSend(store, draft, { now, sendAt: later });
  const date = /^Date: (.+)$/m.exec(getSend(store, r.id)!.raw_mime)?.[1] ?? "";
  assert.equal(Date.parse(date), later, `Date header ${date} should be the scheduled time`);
});

test("validateDraft refuses a message with nothing written, unless it forwards quoted history", () => {
  assert.throws(() => validateDraft({ ...draft, bodyHtml: "<p></p>", quotedHtml: "" }), /Write something/);
  assert.throws(() => validateDraft({ ...draft, bodyHtml: "<p>&nbsp;</p>", quotedHtml: "" }), /Write something/);
  assert.throws(() => validateDraft({ ...draft, bodyHtml: "" }), /Write something/, "a reply that only quotes is a slip");
  assert.doesNotThrow(() => validateDraft({ ...draft, mode: "forward", bodyHtml: "", quotedHtml: "<div>Forwarded message</div>" }));
  assert.doesNotThrow(() => validateDraft(draft));
});

test("attachment sends embed the file in the queue and undo restores the attachment", async () => {
  const store = db();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-send-file-"));
  const file = path.join(dir, "contract.pdf");
  const content = Buffer.from("%PDF-1.7\nTest attachment\n");
  fs.writeFileSync(file, content);
  const attachments = [{ path: file, name: "contract.pdf", mimeType: "application/pdf", size: content.length }];
  try {
    const result = await queueSend(store, { ...draft, attachments });
    const mime = getSend(store, result.id)!.raw_mime;
    assert.match(mime, /Content-Type: application\/pdf/);
    assert.match(mime, /filename=contract.pdf/);
    assert.ok(mime.includes(content.toString("base64")));
    fs.unlinkSync(file);
    assert.equal(getSend(store, result.id)!.raw_mime, mime, "queued message is independent of the file after preparation");
    assert.deepEqual(undoSend(store, result.id).draft?.attachments, attachments);
    await assert.rejects(queueSend(store, { ...draft, attachments }), /contract.pdf could not be read/);
    assert.equal(releasableSends(store, Date.now() + 60_000).length, 0, "missing file never queues an incomplete email");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

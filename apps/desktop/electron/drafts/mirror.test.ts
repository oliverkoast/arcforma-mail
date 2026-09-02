import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GmailClient, type Transport, type TransportInit } from "@arcforma/gmail";
import { enqueueSend, getDraft, listDrafts, listOutbox, openStore, saveDraft, updateAccount, upsertAccount, upsertGmailDraft, type Db, type DraftUpsertPayload } from "@arcforma/store";
import { DraftMirror, LOCAL_WINS_MS, applyDraftUpsertAck, applyDraftUpsertFail, detachDraftForSend, discardDraft, draftsNeedReconcile, mirrorDraft, reconcileGmailDrafts, restoreDraft } from "./mirror.js";

interface Canned {
  status: number;
  body?: unknown;
}
interface Call {
  url: string;
  init: TransportInit;
}

function clientOf(handler: (call: Call) => Canned): { client: GmailClient; calls: Call[] } {
  const calls: Call[] = [];
  const transport: Transport = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    const canned = handler(call);
    return { status: canned.status, headers: { get: () => null }, text: async () => (canned.body === undefined ? "" : JSON.stringify(canned.body)) };
  };
  return { client: new GmailClient({ accessToken: async () => "t", transport, sleep: async () => {}, maxAttempts: 1 }), calls };
}

function tempDb(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-mirror-"));
  const db = openStore(path.join(dir, "mail.db"));
  upsertAccount(db, { id: "arcforma", email: "you@example.com", displayName: "Oliver Korzen" });
  updateAccount(db, "arcforma", { signature_html: "<div>Oliver Korzen<br>Arcforma</div>" });
  return db;
}

const T0 = 1_800_000_000_000;
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

function gmailDraft(id: string, messageId: string, over: { html?: string; subject?: string; to?: string; threadId?: string; inReplyTo?: string } = {}) {
  const html = over.html ?? "<div>From Gmail</div>";
  const headers = [
    { name: "To", value: over.to ?? "dana@northwind.example" },
    { name: "Subject", value: over.subject ?? "Written in Gmail" },
  ];
  if (over.inReplyTo) headers.push({ name: "In-Reply-To", value: over.inReplyTo });
  return { id, message: { id: messageId, threadId: over.threadId ?? `thread-${id}`, labelIds: ["DRAFT"], payload: { mimeType: "text/html", headers, body: { data: b64(html) } } } };
}

const payloadOf = (row: { payload_json: string }) => JSON.parse(row.payload_json) as DraftUpsertPayload;
const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

function localDraft(db: Db, over: Partial<Parameters<typeof saveDraft>[1]> = {}, now = T0): number {
  return saveDraft(db, { accountId: "arcforma", threadId: "t1", mode: "reply", to: [{ email: "dana@northwind.example", name: "Dana" }], subject: "Re: Kickoff", bodyHtml: "<p>9:00 works.</p>", quotedHtml: "<blockquote>Can we do 9:00?</blockquote>", inReplyTo: "<m1@x>", references: "<m1@x>", ...over }, now);
}

test("mirrorDraft queues one outbox row with the sendable message; a second edit before the drain replaces it", async () => {
  const db = tempDb();
  const id = localDraft(db);
  const first = await mirrorDraft(db, id);
  assert.ok(first);
  let rows = listOutbox(db, "arcforma", "pending");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.op, "draftUpsert");
  const p = payloadOf(rows[0]!);
  assert.equal(p.draftId, id);
  assert.equal(p.threadId, "t1");
  assert.equal(p.gmailDraftId, null);
  const mime = decode(p.raw);
  assert.match(mime, /^Subject: Re: Kickoff/m);
  assert.match(mime, /^In-Reply-To: <m1@x>/m);
  assert.match(mime, /gmail_signature/);
  assert.match(mime, /gmail_quote/);
  assert.equal(getDraft(db, id)!.mirror_state, "pending");

  saveDraft(db, { id, accountId: "arcforma", to: [], subject: "Re: Kickoff (edited)", bodyHtml: "<p>10:00 then.</p>" });
  const second = await mirrorDraft(db, id);
  assert.equal(second, first, "the waiting row was reused");
  rows = listOutbox(db, "arcforma", "pending");
  assert.equal(rows.length, 1);
  assert.match(decode(payloadOf(rows[0]!).raw), /^Subject: Re: Kickoff \(edited\)/m);
});

test("the ack records the Gmail ids; a create acked after the draft was sent queues the orphan's deletion; gone drops the row", () => {
  const db = tempDb();
  const id = localDraft(db);
  assert.deepEqual(applyDraftUpsertAck(db, "arcforma", { draftId: id, gmailDraftId: "d1", gmailMessageId: "gm1", gone: false }), { accountId: "arcforma", changed: true });
  let row = getDraft(db, id)!;
  assert.equal(row.gmail_draft_id, "d1");
  assert.equal(row.gmail_message_id, "gm1");
  assert.equal(row.mirror_state, "synced");
  assert.ok(row.mirrored_at);

  applyDraftUpsertFail(db, { draftId: id, raw: "" }, "503 backend", false);
  row = getDraft(db, id)!;
  assert.equal(row.mirror_state, "pending", "a retry keeps reading Saving");
  assert.equal(row.mirror_error, "503 backend");
  applyDraftUpsertFail(db, { draftId: id, raw: "" }, "400 Invalid To header", true);
  assert.equal(getDraft(db, id)!.mirror_state, "failed");

  applyDraftUpsertAck(db, "arcforma", { draftId: id, gmailDraftId: "d1", gmailMessageId: null, gone: true });
  assert.equal(getDraft(db, id), null, "deleted in Gmail while the edit was in flight: the local row follows");

  applyDraftUpsertAck(db, "arcforma", { draftId: 999, gmailDraftId: "d9", gmailMessageId: "gm9", gone: false });
  const deletes = listOutbox(db, "arcforma", "pending").filter((r) => r.op === "draftDelete");
  assert.deepEqual(deletes.map((r) => JSON.parse(r.payload_json)), [{ gmailDraftId: "d9" }], "no local row for the create: Gmail's copy is deleted again");
});

test("discard deletes locally and in Gmail; detaching for send drops the waiting mirror and hands back the Gmail id", async () => {
  const db = tempDb();
  const a = localDraft(db);
  await mirrorDraft(db, a);
  applyDraftUpsertAck(db, "arcforma", { draftId: a, gmailDraftId: "dA", gmailMessageId: "gmA", gone: false });
  assert.deepEqual(discardDraft(db, a), { accountId: "arcforma", queued: true });
  assert.equal(getDraft(db, a), null);
  assert.deepEqual(listOutbox(db, "arcforma", "pending").map((r) => [r.op, JSON.parse(r.payload_json)]), [["draftDelete", { gmailDraftId: "dA" }]]);

  const b = localDraft(db, { subject: "Never mirrored" });
  await mirrorDraft(db, b);
  assert.deepEqual(discardDraft(db, b), { accountId: "arcforma", queued: false }, "nothing in Gmail to delete");
  assert.equal(listOutbox(db, "arcforma", "pending").filter((r) => r.op === "draftUpsert").length, 0, "and the create that never went out is dropped");

  const c = localDraft(db, { subject: "To send" });
  applyDraftUpsertAck(db, "arcforma", { draftId: c, gmailDraftId: "dC", gmailMessageId: "gmC", gone: false });
  await mirrorDraft(db, c);
  assert.equal(detachDraftForSend(db, c), "dC");
  assert.equal(getDraft(db, c), null);
  assert.equal(listOutbox(db, "arcforma", "pending").filter((r) => r.op === "draftUpsert").length, 0);
  assert.equal(discardDraft(db, 12345), null);
});

test("restoreDraft after an undone send puts the row back on the same Gmail draft and queues an update", async () => {
  const db = tempDb();
  const draft = { accountId: "arcforma", threadId: "t1", mode: "reply" as const, to: [{ email: "dana@northwind.example", name: "" }], cc: [], bcc: [], subject: "Re: Kickoff", bodyHtml: "<p>Back.</p>", quotedHtml: "" };
  const id = await restoreDraft(db, draft, "dOld");
  const row = getDraft(db, id)!;
  assert.equal(row.gmail_draft_id, "dOld");
  assert.equal(row.mirror_state, "pending");
  const pending = listOutbox(db, "arcforma", "pending");
  assert.equal(pending.length, 1);
  assert.equal(payloadOf(pending[0]!).gmailDraftId, "dOld", "the update reuses the draft Gmail still holds");
});

test("draftsNeedReconcile: a foreign DRAFT message, or a mirrored one going away, triggers a drafts.list", () => {
  const db = tempDb();
  const id = localDraft(db);
  applyDraftUpsertAck(db, "arcforma", { draftId: id, gmailDraftId: "d1", gmailMessageId: "ours", gone: false });
  const added = (messageId: string, labels: string[]) => ({ type: "messageAdded" as const, historyId: "1", messageId, threadId: "t", labelIds: labels });
  assert.equal(draftsNeedReconcile(db, "arcforma", []), false);
  assert.equal(draftsNeedReconcile(db, "arcforma", [added("ours", ["DRAFT"])]), false, "our own mirror landing is not news");
  assert.equal(draftsNeedReconcile(db, "arcforma", [added("theirs", ["DRAFT"])]), true, "a draft written in Gmail");
  assert.equal(draftsNeedReconcile(db, "arcforma", [added("mail", ["INBOX", "UNREAD"])]), false);
  assert.equal(draftsNeedReconcile(db, "arcforma", [{ type: "messageDeleted", historyId: "1", messageId: "ours", threadId: "t" }]), true, "our draft deleted in Gmail");
  assert.equal(draftsNeedReconcile(db, "arcforma", [{ type: "messageDeleted", historyId: "1", messageId: "other", threadId: "t" }]), false);
  assert.equal(draftsNeedReconcile(db, "arcforma", [{ type: "labelRemoved", historyId: "1", messageId: "ours", threadId: "t", changedLabelIds: ["DRAFT"] }]), true, "our draft sent from Gmail");
  assert.equal(draftsNeedReconcile(db, "arcforma", [{ type: "labelAdded", historyId: "1", messageId: "new", threadId: "t", changedLabelIds: ["DRAFT"] }]), true);
});

test("reconcile imports drafts written in Gmail as local drafts, and drops local rows whose Gmail draft is gone", async () => {
  const db = tempDb();
  const kept = localDraft(db, { subject: "Still there" });
  applyDraftUpsertAck(db, "arcforma", { draftId: kept, gmailDraftId: "dKept", gmailMessageId: "gmKept", gone: false });
  const vanished = localDraft(db, { subject: "Deleted in Gmail" });
  applyDraftUpsertAck(db, "arcforma", { draftId: vanished, gmailDraftId: "dGone", gmailMessageId: "gmGone", gone: false });
  await mirrorDraft(db, vanished);
  const unmirrored = localDraft(db, { subject: "Not mirrored yet" });

  const { client, calls } = clientOf((call) => {
    if (/\/drafts\?/.test(call.url)) return { status: 200, body: { drafts: [{ id: "dKept", message: { id: "gmKept", threadId: "t1" } }, { id: "dNew", message: { id: "gmNew", threadId: "thread-dNew" } }] } };
    if (/\/drafts\/dNew\?/.test(call.url)) return { status: 200, body: gmailDraft("dNew", "gmNew", { html: "<div>Hello from the web</div>", subject: "Web draft" }) };
    throw new Error(`unexpected ${call.url}`);
  });
  const r = await reconcileGmailDrafts(db, "arcforma", client, { ownerAddresses: ["you@example.com"], now: T0 + 3_600_000 });
  assert.deepEqual(r, { imported: 1, updated: 0, dropped: 1, pushed: 0 });
  assert.equal(getDraft(db, vanished), null, "deleted in Gmail, deleted here");
  assert.equal(listOutbox(db, "arcforma", "pending").filter((row) => row.op === "draftUpsert" && payloadOf(row).draftId === vanished).length, 0, "its waiting update went with it");
  assert.ok(getDraft(db, kept));
  assert.ok(getDraft(db, unmirrored), "a draft still on its way up is left alone");
  const imported = listDrafts(db).find((d) => d.gmail_draft_id === "dNew")!;
  assert.equal(imported.origin, "gmail");
  assert.equal(imported.subject, "Web draft");
  assert.equal(imported.body_html, "<div>Hello from the web</div>");
  assert.equal(imported.mirror_state, "synced");
  assert.equal(imported.gmail_message_id, "gmNew");
  assert.equal(imported.local_edited_at, null);
  assert.equal(calls.filter((c) => /drafts\/dNew/.test(c.url)).length, 1, "only the new draft was fetched");
});

test("an edit made in Gmail replaces the local text, unless the local draft was edited in the last minute, in which case the local text goes up", async () => {
  const db = tempDb();
  const stale = localDraft(db, { subject: "Edited in Gmail later" }, T0 - 10 * 60_000);
  applyDraftUpsertAck(db, "arcforma", { draftId: stale, gmailDraftId: "dStale", gmailMessageId: "gmOld", gone: false });
  await mirrorDraft(db, stale);
  const fresh = localDraft(db, { subject: "Edited here just now", bodyHtml: "<p>Local wins.</p>" }, T0 - LOCAL_WINS_MS + 5000);
  applyDraftUpsertAck(db, "arcforma", { draftId: fresh, gmailDraftId: "dFresh", gmailMessageId: "gmFreshOld", gone: false });

  const { client, calls } = clientOf((call) => {
    if (/\/drafts\?/.test(call.url)) return { status: 200, body: { drafts: [{ id: "dStale", message: { id: "gmNew", threadId: "t1" } }, { id: "dFresh", message: { id: "gmFreshNew", threadId: "t1" } }] } };
    if (/\/drafts\/dStale\?/.test(call.url)) return { status: 200, body: gmailDraft("dStale", "gmNew", { html: "<div>Rewritten on the phone</div>", subject: "Re: Kickoff", threadId: "t1", inReplyTo: "<m1@x>" }) };
    throw new Error(`unexpected ${call.url}`);
  });
  const r = await reconcileGmailDrafts(db, "arcforma", client, { now: T0 });
  assert.deepEqual(r, { imported: 0, updated: 1, dropped: 0, pushed: 1 });

  const replaced = getDraft(db, stale)!;
  assert.equal(replaced.body_html, "<div>Rewritten on the phone</div>", "Gmail's edit won over a ten-minute-old local one");
  assert.equal(replaced.gmail_message_id, "gmNew");
  assert.equal(replaced.mirror_state, "synced");
  assert.equal(replaced.origin, "local", "still the row that was written here");
  assert.equal(listOutbox(db, "arcforma", "pending").filter((row) => row.op === "draftUpsert" && payloadOf(row).draftId === stale).length, 0, "the stale update that was waiting would have overwritten the phone's edit; it is gone");

  const kept = getDraft(db, fresh)!;
  assert.equal(kept.body_html, "<p>Local wins.</p>");
  assert.equal(kept.gmail_message_id, "gmFreshOld", "not touched until our update lands");
  assert.equal(kept.mirror_state, "pending");
  const up = listOutbox(db, "arcforma", "pending").filter((row) => row.op === "draftUpsert" && payloadOf(row).draftId === fresh);
  assert.equal(up.length, 1);
  assert.equal(payloadOf(up[0]!).gmailDraftId, "dFresh");
  assert.equal(calls.filter((c) => /drafts\/dFresh/.test(c.url)).length, 0, "never fetched: local wins without reading");
});

test("a Gmail draft whose message is waiting in the send queue is not imported back as a draft", async () => {
  const db = tempDb();
  enqueueSend(db, { accountId: "arcforma", rawMime: "RAW", sendAt: T0 + 60_000, undoUntil: T0 + 60_000, meta: { draft: null, gmailDraftId: "dQueued" } });
  const { client, calls } = clientOf((call) => {
    if (/\/drafts\?/.test(call.url)) return { status: 200, body: { drafts: [{ id: "dQueued", message: { id: "gmQ", threadId: "t1" } }] } };
    throw new Error(`unexpected ${call.url}`);
  });
  const r = await reconcileGmailDrafts(db, "arcforma", client, { now: T0 });
  assert.deepEqual(r, { imported: 0, updated: 0, dropped: 0, pushed: 0 });
  assert.equal(listDrafts(db).length, 0);
  assert.equal(calls.length, 1);
});

test("a draft imported from Gmail edits like any other: the next save mirrors it back through drafts.update", async () => {
  const db = tempDb();
  const id = upsertGmailDraft(db, { accountId: "arcforma", gmailDraftId: "dWeb", gmailMessageId: "gmWeb", threadId: null, mode: "new", to: [{ email: "dana@northwind.example", name: "" }], cc: [], bcc: [], subject: "From the web", bodyHtml: "<p>Hi</p>", quotedHtml: "", inReplyTo: null, references: null }, T0);
  assert.equal(getDraft(db, id)!.local_edited_at, null);
  saveDraft(db, { id, accountId: "arcforma", to: [{ email: "dana@northwind.example", name: "" }], subject: "From the web, finished here", bodyHtml: "<p>Hi. Done.</p>" }, T0 + 1000);
  const row = getDraft(db, id)!;
  assert.equal(row.local_edited_at, T0 + 1000);
  assert.equal(row.origin, "gmail");
  assert.equal(row.gmail_draft_id, "dWeb", "the tie to Gmail survives the edit");
  await mirrorDraft(db, id);
  const p = payloadOf(listOutbox(db, "arcforma", "pending")[0]!);
  assert.equal(p.gmailDraftId, "dWeb");
  assert.match(decode(p.raw), /^Subject: From the web, finished here/m);
});

test("the mirror host fires after the quiet time and pokes the account's drain", async () => {
  const db = tempDb();
  const id = localDraft(db);
  const pokes: string[] = [];
  const mirror = new DraftMirror(db, { poke: (a) => pokes.push(a) }, { quietMs: 30 });
  mirror.touch(id, "arcforma");
  mirror.touch(id, "arcforma");
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(listOutbox(db, "arcforma", "pending").length, 0, "still typing");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(listOutbox(db, "arcforma", "pending").length, 1);
  assert.deepEqual(pokes, ["arcforma"]);
  mirror.touch(id, "arcforma", true);
  mirror.cancel(id);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(listOutbox(db, "arcforma", "pending").length, 1, "cancelled before it fired");
  mirror.stop();
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { GmailClient } from "./client.js";
import { getGmailDraft, importGmailDraft, listGmailDrafts, splitDraftHtml, textToParagraphs, type GmailDraft } from "./drafts.js";
import { LabelResolver, executeOutboxOp, type DraftUpsertResult, type OutboxJob } from "./outbox.js";
import type { GmailPart } from "./mime.js";
import { fakeClock, fakeTransport, token } from "../test/helpers.js";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

function part(mimeType: string, data: string, charset = "utf-8"): GmailPart {
  return { mimeType, headers: [{ name: "Content-Type", value: `${mimeType}; charset=${charset}` }], body: { data: b64(data), size: data.length } };
}

function draft(id: string, over: { headers: Array<[string, string]>; html?: string; text?: string; threadId?: string; messageId?: string }): GmailDraft {
  const parts: GmailPart[] = [];
  if (over.text !== undefined) parts.push(part("text/plain", over.text));
  if (over.html !== undefined) parts.push(part("text/html", over.html));
  const payload: GmailPart = parts.length === 1 ? parts[0]! : { mimeType: "multipart/alternative", parts };
  return {
    id,
    message: {
      id: over.messageId ?? `msg-${id}`,
      threadId: over.threadId ?? `thread-${id}`,
      labelIds: ["DRAFT"],
      payload: { ...payload, headers: [...(payload.headers ?? []), ...over.headers.map(([name, value]) => ({ name, value }))] },
    },
  };
}

test("a new HTML draft written in Gmail imports as a new-message compose with its recipients and body", () => {
  const d = draft("d1", {
    headers: [["To", "Dana Reyes <dana@northwind.example>, sam@harbor.example"], ["Cc", "Oliver Korzen <you@example.com>, priya@northwind.example"], ["Subject", "Kickoff agenda"]],
    html: '<div dir="ltr">Here is the agenda.<div><br></div><div>Three items.</div></div>',
    text: "Here is the agenda.\n\nThree items.",
  });
  const out = importGmailDraft(d, ["you@example.com"]);
  assert.equal(out.gmailDraftId, "d1");
  assert.equal(out.gmailMessageId, "msg-d1");
  assert.equal(out.mode, "new");
  assert.equal(out.threadId, null, "a draft that answers nothing owns its thread; the send path starts a fresh one");
  assert.deepEqual(out.to, [{ email: "dana@northwind.example", name: "Dana Reyes" }, { email: "sam@harbor.example", name: "" }]);
  assert.deepEqual(out.cc, [{ email: "priya@northwind.example", name: "" }], "the account's own address drops out of Cc");
  assert.equal(out.subject, "Kickoff agenda");
  assert.equal(out.bodyHtml, '<div dir="ltr">Here is the agenda.<div><br></div><div>Three items.</div></div>', "text/html wins over text/plain");
  assert.equal(out.quotedHtml, "");
  assert.equal(out.inReplyTo, null);
});

test("a plain-text draft becomes paragraphs, and its quoted lines become the quoted history", () => {
  const d = draft("d2", {
    headers: [["To", "dana@northwind.example"], ["Subject", "Re: Kickoff"], ["In-Reply-To", "<m1@x>"], ["References", "<m0@x> <m1@x>"]],
    text: "Works for me.\nSee you then.\n\nBest\n\nOn Tue, Dana wrote:\n> Can we do 9:00?\n> Or 10?",
    threadId: "t-kickoff",
  });
  const out = importGmailDraft(d);
  assert.equal(out.bodyHtml, "<p>Works for me.<br>See you then.</p><p>Best</p>");
  assert.match(out.quotedHtml, /^<blockquote class="gmail_quote">On Tue, Dana wrote:<br>Can we do 9:00\?<br>Or 10\?<\/blockquote>$/);
  assert.equal(out.mode, "reply");
  assert.equal(out.threadId, "t-kickoff", "a reply keeps the thread it answers");
  assert.equal(out.inReplyTo, "<m1@x>");
  assert.equal(out.references, "<m0@x> <m1@x>");
  assert.equal(textToParagraphs("a < b\r\n\r\n\r\nc"), "<p>a &lt; b</p><p>c</p>");
});

test("a reply draft with a signature and a quote imports as body, quote, no signature; reply all when others are copied", () => {
  const html =
    '<div dir="ltr">9:00 works.<div>Thanks.</div><br><br><div class="gmail_signature" data-smartmail="gmail_signature"><div dir="ltr">Oliver Korzen<div>Arcforma</div></div></div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Tue, Dana wrote:<br></div><blockquote class="gmail_quote" style="margin:0">Can we do 9:00?<div>Or 10?</div></blockquote></div></div>';
  const d = draft("d3", { headers: [["To", "dana@northwind.example"], ["Cc", "priya@northwind.example"], ["Subject", "Re: Kickoff"], ["In-Reply-To", "<m1@x>"]], html, threadId: "t-kickoff" });
  const out = importGmailDraft(d, ["you@example.com"]);
  assert.equal(out.mode, "replyAll");
  assert.equal(out.bodyHtml, '<div dir="ltr">9:00 works.<div>Thanks.</div></div>', "signature and quote wrapper gone, outer div kept whole");
  assert.equal(out.quotedHtml, '<div dir="ltr" class="gmail_attr">On Tue, Dana wrote:<br></div><blockquote class="gmail_quote" style="margin:0">Can we do 9:00?<div>Or 10?</div></blockquote>');
  assert.doesNotMatch(out.bodyHtml, /gmail_signature/);
  assert.doesNotMatch(out.quotedHtml, /gmail_signature/);
});

test("splitDraftHtml handles the shapes the send path writes, and unbalanced markup", () => {
  // What buildRawMessage produces: body, signature, quote, in that order.
  const ours = '<p>Hi</p><br><br><div class="gmail_signature" data-smartmail="gmail_signature"><div>Oliver</div></div><br><div class="gmail_quote"><blockquote>old</blockquote></div>';
  assert.deepEqual(splitDraftHtml(ours), { bodyHtml: "<p>Hi</p>", quotedHtml: "<blockquote>old</blockquote>" });
  assert.deepEqual(splitDraftHtml("<p>Only text</p>"), { bodyHtml: "<p>Only text</p>", quotedHtml: "" });
  assert.deepEqual(splitDraftHtml('<p>Hi</p><div class="gmail_quote"><div>never closed'), { bodyHtml: "<p>Hi</p>", quotedHtml: "<div>never closed" });
  const fwd = '<div>See below</div><br><div class="gmail_quote">---------- Forwarded message ---------<br>From: x</div>';
  assert.deepEqual(splitDraftHtml(fwd), { bodyHtml: "<div>See below</div>", quotedHtml: "---------- Forwarded message ---------<br>From: x" });
});

test("a forwarded draft reads as a forward from its subject", () => {
  const d = draft("d4", { headers: [["To", "sam@harbor.example"], ["Subject", "Fwd: Invoice"]], html: "<div>See below</div>" });
  assert.equal(importGmailDraft(d).mode, "forward");
});

test("drafts.list pages until Gmail runs out; drafts.get asks for the full message", async () => {
  const { transport, calls } = fakeTransport([
    { status: 200, body: { drafts: [{ id: "d1", message: { id: "m1", threadId: "t1" } }], nextPageToken: "p2" } },
    { status: 200, body: { drafts: [{ id: "d2", message: { id: "m2", threadId: "t2" } }] } },
    { status: 200, body: draft("d2", { headers: [["Subject", "x"]], text: "hi" }) },
  ]);
  const client = new GmailClient({ accessToken: token, transport, sleep: async () => {} });
  const refs = await listGmailDrafts(client);
  assert.deepEqual(refs.map((r) => r.id), ["d1", "d2"]);
  assert.match(calls[1]!.url, /pageToken=p2/);
  const full = await getGmailDraft(client, "d2");
  assert.equal(full.message.id, "msg-d2");
  assert.match(calls[2]!.url, /drafts\/d2\?format=full$/);
});

// ---- outbox ops ------------------------------------------------------------------

const labels = (client: GmailClient) => new LabelResolver(client);

test("draftUpsert creates on the first pass and updates by id after that, carrying the thread", async () => {
  const { transport, calls } = fakeTransport([
    { status: 200, body: { id: "d1", message: { id: "m1", threadId: "t1" } } },
    { status: 200, body: { id: "d1", message: { id: "m2", threadId: "t1" } } },
  ]);
  const client = new GmailClient({ accessToken: token, transport, sleep: async () => {} });
  const create: OutboxJob = { id: 1, op: "draftUpsert", attempts: 0, payload: { draftId: 7, raw: "UkFX", threadId: "t1", gmailDraftId: null } };
  const first = await executeOutboxOp(client, labels(client), create);
  assert.equal(first.ok, true);
  assert.deepEqual((first as { result: DraftUpsertResult }).result, { draftId: 7, gmailDraftId: "d1", gmailMessageId: "m1", gone: false });
  assert.equal(calls[0]!.init.method, "POST");
  assert.match(calls[0]!.url, /\/drafts$/);
  assert.deepEqual(JSON.parse(calls[0]!.init.body!), { message: { raw: "UkFX", threadId: "t1" } });

  const update: OutboxJob = { id: 2, op: "draftUpsert", attempts: 0, payload: { draftId: 7, raw: "UkFXMg", threadId: "t1", gmailDraftId: "d1" } };
  const second = await executeOutboxOp(client, labels(client), update);
  assert.deepEqual((second as { result: DraftUpsertResult }).result, { draftId: 7, gmailDraftId: "d1", gmailMessageId: "m2", gone: false });
  assert.equal(calls[1]!.init.method, "PUT");
  assert.match(calls[1]!.url, /\/drafts\/d1$/);
  assert.deepEqual(JSON.parse(calls[1]!.init.body!), { id: "d1", message: { raw: "UkFXMg", threadId: "t1" } });
});

test("an update whose Gmail draft is gone reports gone rather than failing, so the local row can follow it", async () => {
  const { transport } = fakeTransport([{ status: 404, body: { error: { message: "Requested entity was not found." } } }]);
  const client = new GmailClient({ accessToken: token, transport, sleep: async () => {} });
  const out = await executeOutboxOp(client, labels(client), { id: 1, op: "draftUpsert", attempts: 0, payload: { draftId: 7, raw: "UkFX", gmailDraftId: "d1" } });
  assert.equal(out.ok, true);
  assert.deepEqual((out as { result: DraftUpsertResult }).result, { draftId: 7, gmailDraftId: "d1", gmailMessageId: null, gone: true });
});

test("draftDelete removes the Gmail draft after a send, and an already deleted draft counts as done", async () => {
  const { transport, calls } = fakeTransport([{ status: 204 }, { status: 404, body: { error: { message: "gone" } } }]);
  const client = new GmailClient({ accessToken: token, transport, sleep: async () => {} });
  const job: OutboxJob = { id: 1, op: "draftDelete", attempts: 0, payload: { gmailDraftId: "d1" } };
  assert.equal((await executeOutboxOp(client, labels(client), job)).ok, true);
  assert.equal(calls[0]!.init.method, "DELETE");
  assert.match(calls[0]!.url, /\/drafts\/d1$/);
  assert.equal((await executeOutboxOp(client, labels(client), job)).ok, true, "404 is the outcome that was wanted");
});

test("a rate limit on a draft op schedules a retry; a 400 is terminal", async () => {
  const clock = fakeClock();
  let status = 429;
  const { transport } = fakeTransport(() => ({ status, body: { error: { message: status === 429 ? "Rate limit" : "Invalid", errors: [{ reason: status === 429 ? "rateLimitExceeded" : "invalidArgument" }] } }, headers: status === 429 ? { "retry-after": "7" } : {} }));
  const client = new GmailClient({ accessToken: token, transport, sleep: clock.sleep, now: clock.now, maxAttempts: 1 });
  const job: OutboxJob = { id: 1, op: "draftUpsert", attempts: 0, payload: { draftId: 7, raw: "UkFX" } };
  const limited = await executeOutboxOp(client, labels(client), job, clock.now());
  assert.equal(limited.ok, false);
  assert.equal((limited as { retryAt: number | null }).retryAt, clock.now() + 7000, "Retry-After sets the retry time");
  status = 400;
  const bad = await executeOutboxOp(client, labels(client), job, clock.now());
  assert.equal(bad.ok, false);
  assert.equal((bad as { retryAt: number | null }).retryAt, null);
  assert.match((bad as { error: string }).error, /Invalid/);
});

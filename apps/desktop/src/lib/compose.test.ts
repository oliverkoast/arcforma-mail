import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDraft, forwardSubject, parseAddresses, quotedHtml, recipientsFor, referencesFor, replySubject, replyTarget, textToHtml } from "./compose";
import type { MessageView, ThreadSummary } from "../../shared/types";

const owners = new Set(["you@example.com", "you@example.net"]);

function msg(over: Partial<MessageView>): MessageView {
  return {
    accountId: "arcforma",
    id: "m",
    threadId: "t",
    internalDate: Date.UTC(2026, 8, 1, 17, 0),
    from: { email: "dana@northwind.example", name: "Dana Reyes" },
    replyTo: null,
    to: [{ email: "you@example.com", name: "Oliver Korzen" }],
    cc: [],
    messageIdHeader: "<m@x>",
    references: null,
    subject: "Kickoff",
    snippet: "snippet",
    labelIds: [],
    direction: "in",
    isAuto: false,
    hasAttachments: false,
    body: { html: "<p>Can we do 9:00?</p>", text: null, attachments: [] },
    loadImages: false,
    ...over,
  };
}

const thread: ThreadSummary = { accountId: "arcforma", id: "t", subject: "Kickoff", snippet: "", participants: [], lastMessageAt: 0, sortAt: 0, messageCount: 2, unread: false, starred: false, inInbox: true, hasAttachments: false, split: null, type: null, categoryId: null, wakeAt: null, noReplyBy: null, queue: null };

test("subject prefixes stack once", () => {
  assert.equal(replySubject("Kickoff"), "Re: Kickoff");
  assert.equal(replySubject("Re: Kickoff"), "Re: Kickoff");
  assert.equal(replySubject("RE: Kickoff"), "RE: Kickoff");
  assert.equal(forwardSubject("Kickoff"), "Fwd: Kickoff");
  assert.equal(forwardSubject("Fwd: Kickoff"), "Fwd: Kickoff");
  assert.equal(forwardSubject("FW: Kickoff"), "FW: Kickoff");
});

test("reply answers the sender, or Reply-To when set, never an owner", () => {
  const m = msg({ cc: [{ email: "priya@northwind.example", name: "Priya" }, { email: "you@example.net", name: "" }] });
  assert.deepEqual(recipientsFor("reply", m, owners), { to: [{ email: "dana@northwind.example", name: "Dana Reyes" }], cc: [] });
  const rt = msg({ replyTo: { email: "dana.reyes@lists.example", name: "Dana via list" } });
  assert.deepEqual(recipientsFor("reply", rt, owners).to, [{ email: "dana.reyes@lists.example", name: "Dana via list" }]);
});

test("reply all keeps everyone on To and Cc except owners and the primary recipient", () => {
  const m = msg({
    to: [{ email: "you@example.com", name: "Oliver" }, { email: "sam@harbor.example", name: "Sam" }],
    cc: [{ email: "priya@northwind.example", name: "Priya" }, { email: "Dana@Northwind.example", name: "dup" }, { email: "you@example.net", name: "" }],
  });
  const r = recipientsFor("replyAll", m, owners);
  assert.deepEqual(r.to, [{ email: "dana@northwind.example", name: "Dana Reyes" }]);
  assert.deepEqual(r.cc, [{ email: "sam@harbor.example", name: "Sam" }, { email: "priya@northwind.example", name: "Priya" }]);
});

test("replying to your own message goes back to its recipients", () => {
  const mine = msg({ from: { email: "you@example.com", name: "Oliver" }, to: [{ email: "dana@northwind.example", name: "Dana" }], cc: [{ email: "priya@northwind.example", name: "Priya" }], direction: "out" });
  assert.deepEqual(recipientsFor("reply", mine, owners).to, [{ email: "dana@northwind.example", name: "Dana" }]);
  assert.deepEqual(recipientsFor("replyAll", mine, owners).cc, [{ email: "priya@northwind.example", name: "Priya" }]);
});

test("forward and new start with no recipients", () => {
  assert.deepEqual(recipientsFor("forward", msg({}), owners), { to: [], cc: [] });
  assert.deepEqual(recipientsFor("new", null, owners), { to: [], cc: [] });
});

test("replyTarget picks the last inbound message and references chain correctly", () => {
  const a = msg({ id: "a", direction: "in", messageIdHeader: "<a@x>" });
  const b = msg({ id: "b", direction: "out", messageIdHeader: "<b@x>", references: "<a@x>" });
  const c = msg({ id: "c", direction: "in", messageIdHeader: "<c@x>", references: "<a@x> <b@x>" });
  assert.equal(replyTarget([a, b, c])!.id, "c");
  assert.equal(replyTarget([a, b])!.id, "a");
  assert.equal(replyTarget([b])!.id, "b", "an all-outbound thread replies to the last message");
  assert.deepEqual(referencesFor(c), { inReplyTo: "<c@x>", references: "<a@x> <b@x> <c@x>" });
  assert.deepEqual(referencesFor(msg({ messageIdHeader: null })), { inReplyTo: null, references: null });
});

test("buildDraft assembles reply, reply all, forward, and new", () => {
  const a = msg({ id: "a", direction: "in", cc: [{ email: "priya@northwind.example", name: "Priya" }] });
  const reply = buildDraft({ mode: "reply", accountId: "arcforma", thread, messages: [a], owners });
  assert.equal(reply.subject, "Re: Kickoff");
  assert.equal(reply.threadId, "t");
  assert.equal(reply.inReplyTo, "<m@x>");
  assert.deepEqual(reply.to.map((x) => x.email), ["dana@northwind.example"]);
  assert.deepEqual(reply.cc, []);
  assert.match(reply.quotedHtml, /wrote:<\/div><blockquote/);
  assert.match(reply.quotedHtml, /Can we do 9:00\?/);
  const all = buildDraft({ mode: "replyAll", accountId: "arcforma", thread, messages: [a], owners });
  assert.deepEqual(all.cc.map((x) => x.email), ["priya@northwind.example"]);
  const fwd = buildDraft({ mode: "forward", accountId: "arcforma", thread, messages: [a], owners });
  assert.equal(fwd.subject, "Fwd: Kickoff");
  assert.equal(fwd.threadId, null, "a forward starts a new thread");
  assert.equal(fwd.inReplyTo, null);
  assert.deepEqual(fwd.to, []);
  assert.match(fwd.quotedHtml, /Forwarded message/);
  assert.match(fwd.quotedHtml, /From: Dana Reyes &lt;dana@northwind.example&gt;/);
  const fresh = buildDraft({ mode: "new", accountId: "formai", thread: null, messages: [], owners });
  assert.deepEqual([fresh.subject, fresh.quotedHtml, fresh.threadId, fresh.to.length], ["", "", null, 0]);
  const sanitized = quotedHtml("reply", msg({ body: { html: "<p>x</p><script>1</script>", text: null, attachments: [] } }), (h) => h.replace(/<script>.*?<\/script>/g, ""));
  assert.equal(sanitized.includes("<script>"), false);
});

test("parseAddresses and textToHtml", () => {
  assert.deepEqual(parseAddresses('Dana Reyes <Dana@Northwind.example>, sam@harbor.example "Priya N" <priya@northwind.example>'), [
    { email: "dana@northwind.example", name: "Dana Reyes" },
    { email: "sam@harbor.example", name: "" },
    { email: "priya@northwind.example", name: "Priya N" },
  ]);
  assert.deepEqual(parseAddresses(""), []);
  assert.equal(textToHtml("Yes, 9:00 works.\n\nSee you Tuesday.\nOliver"), "<p>Yes, 9:00 works.</p><p>See you Tuesday.<br>Oliver</p>");
});

test("forwarding a message with attachments is an explicit error, never a silent text-only forward", () => {
  const withFile = msg({ body: { html: "<p>See attached.</p>", text: null, attachments: [{ filename: "deck.pdf", mimeType: "application/pdf", size: 1024, inline: false }] } });
  assert.throws(() => buildDraft({ mode: "forward", accountId: "arcforma", thread, messages: [withFile], owners }), /Forwarding attachments is not supported yet/);
  const inlineOnly = msg({ body: { html: "<p>logo</p>", text: null, attachments: [{ filename: "logo.png", mimeType: "image/png", size: 10, inline: true }] } });
  assert.equal(buildDraft({ mode: "forward", accountId: "arcforma", thread, messages: [inlineOnly], owners }).mode, "forward", "inline images are part of the body");
  assert.equal(buildDraft({ mode: "reply", accountId: "arcforma", thread, messages: [withFile], owners }).mode, "reply", "a reply does not carry attachments, so it is fine");
  const unfetched = msg({ body: null, hasAttachments: true });
  assert.throws(() => buildDraft({ mode: "forward", accountId: "arcforma", thread, messages: [unfetched], owners }), /not supported yet/, "the metadata flag is enough when the body is not cached yet");
});

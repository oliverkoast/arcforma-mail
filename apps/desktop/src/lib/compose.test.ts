import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDraft, draftPreview, forwardSubject, hasBody, mergePending, parseAddresses, quotedHtml, recipientLine, recipientsFor, referencesFor, replySubject, replyTarget, sentMessage, textToHtml } from "./compose";
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

const thread: ThreadSummary = { accountId: "arcforma", id: "t", subject: "Kickoff", snippet: "", participants: [], lastMessageAt: 0, sortAt: 0, messageCount: 2, unread: false, starred: false, inInbox: true, hasAttachments: false, split: null, type: null, categoryId: null, wakeAt: null, noReplyBy: null, queue: null, canUnsubscribe: false, unsubscribeState: null };

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

test("the collapsed recipient line reads To then cc, names first, addresses when there is no name", () => {
  const dana = { email: "dana@northwind.example", name: "Dana Reyes" };
  const priya = { email: "priya@northwind.example", name: "Priya" };
  const sam = { email: "sam@harbor.example", name: "" };
  assert.equal(recipientLine([dana], [priya]), "To Dana Reyes, cc Priya");
  assert.equal(recipientLine([dana, sam], []), "To Dana Reyes, sam@harbor.example");
  assert.equal(recipientLine([dana], [priya, sam]), "To Dana Reyes, cc Priya, sam@harbor.example");
  assert.equal(recipientLine([], [priya]), "cc Priya");
  assert.equal(recipientLine([], []), "No recipients yet");
});

test("the strip shows the first words of the draft; hasBody ignores recipients and empty paragraphs", () => {
  assert.equal(draftPreview("<p>Yes, 9:00 works.</p><p>See you Tuesday.</p>"), "Yes, 9:00 works. See you Tuesday.");
  assert.equal(draftPreview("<p></p>"), "(empty)");
  assert.equal(draftPreview("<p>Tom &amp; Jerry&nbsp;&lt;3</p>"), "Tom & Jerry <3");
  const long = draftPreview(`<p>${"word ".repeat(40).trim()}</p>`);
  assert.ok(long.endsWith("..."), "a long body is cut");
  assert.ok(long.length <= 76, `cut near the limit: ${long.length}`);
  assert.equal(long.includes("  "), false);
  assert.equal(hasBody({ bodyHtml: "<p></p>" }), false);
  assert.equal(hasBody({ bodyHtml: "<p>&nbsp;</p>" }), false);
  assert.equal(hasBody({ bodyHtml: "<p>ok</p>" }), true);
});

test("a reply to a chosen message takes its recipients, subject, Message-ID, and only its body in the quote", () => {
  const first = msg({ id: "a", messageIdHeader: "<a@x>", subject: "Kickoff", body: { html: "<p>first mail</p>", text: null, attachments: [] } });
  const mine = msg({ id: "b", direction: "out", from: { email: "you@example.com", name: "Oliver" }, to: [{ email: "dana@northwind.example", name: "Dana" }], messageIdHeader: "<b@x>", references: "<a@x>" });
  const mid = msg({
    id: "c",
    from: { email: "priya@northwind.example", name: "Priya Natarajan" },
    cc: [{ email: "dana@northwind.example", name: "Dana Reyes" }],
    messageIdHeader: "<c@x>",
    references: "<a@x> <b@x>",
    subject: "Re: Kickoff (Priya)",
    body: { html: "<p>middle mail</p>", text: null, attachments: [] },
  });
  const last = msg({ id: "d", messageIdHeader: "<d@x>", references: "<a@x> <b@x> <c@x>", body: { html: "<p>last mail</p>", text: null, attachments: [] } });
  const messages = [first, mine, mid, last];

  const reply = buildDraft({ mode: "reply", accountId: "arcforma", thread, messages, owners, targetId: "c" });
  assert.deepEqual(reply.to, [{ email: "priya@northwind.example", name: "Priya Natarajan" }]);
  assert.deepEqual(reply.cc, []);
  assert.equal(reply.subject, "Re: Kickoff (Priya)", "the subject comes from the chosen message, not the thread");
  assert.equal(reply.inReplyTo, "<c@x>");
  assert.equal(reply.references, "<a@x> <b@x> <c@x>");
  assert.match(reply.quotedHtml, /middle mail/);
  assert.doesNotMatch(reply.quotedHtml, /last mail|first mail/, "only the chosen message is quoted");
  assert.equal(reply.threadId, "t");

  const all = buildDraft({ mode: "replyAll", accountId: "arcforma", thread, messages, owners, targetId: "c" });
  assert.deepEqual(all.to.map((a) => a.email), ["priya@northwind.example"]);
  assert.deepEqual(all.cc.map((a) => a.email), ["dana@northwind.example"]);

  const fwd = buildDraft({ mode: "forward", accountId: "arcforma", thread, messages, owners, targetId: "c" });
  assert.equal(fwd.subject, "Fwd: Re: Kickoff (Priya)");
  assert.match(fwd.quotedHtml, /From: Priya Natarajan/);
  assert.match(fwd.quotedHtml, /middle mail/);
  assert.doesNotMatch(fwd.quotedHtml, /last mail/);

  const own = buildDraft({ mode: "reply", accountId: "arcforma", thread, messages, owners, targetId: "b" });
  assert.deepEqual(own.to.map((a) => a.email), ["dana@northwind.example"], "replying to your own mid-thread message goes back to its recipients");
  assert.equal(own.inReplyTo, "<b@x>");

  const unknown = buildDraft({ mode: "reply", accountId: "arcforma", thread, messages, owners, targetId: "nope" });
  assert.equal(unknown.inReplyTo, "<d@x>", "an unknown id falls back to the last inbound message");
  assert.equal(unknown.subject, "Re: Kickoff", "and to the thread subject");
});

test("the optimistic sent message stands in until the sync carries an outbound message at or after its time", () => {
  const draft = buildDraft({ mode: "reply", accountId: "arcforma", thread, messages: [msg({})], owners, bodyHtml: "<p>Yes, 9:00 works.</p>" });
  const at = Date.UTC(2026, 8, 2, 10, 0);
  const sent = sentMessage({ draft, sendId: 7, sentAt: at, from: { email: "you@example.com", name: "Oliver Korzen" } });
  assert.equal(sent.id, "pending:7");
  assert.equal(sent.direction, "out");
  assert.equal(sent.threadId, "t");
  assert.equal(sent.body?.html, "<p>Yes, 9:00 works.</p>");
  assert.equal(sent.snippet, "Yes, 9:00 works.");
  assert.deepEqual(sent.to.map((a) => a.email), ["dana@northwind.example"]);
  const inbound = msg({ id: "in", internalDate: at - 3_600_000 });
  assert.deepEqual(mergePending([inbound], [sent], at + 5_000).map((m) => m.id), ["in", "pending:7"], "nothing outbound yet: the pending message stays");
  const real = msg({ id: "real", direction: "out", internalDate: at + 2_000, from: { email: "you@example.com", name: "Oliver" } });
  assert.deepEqual(mergePending([inbound, real], [sent], at + 5_000).map((m) => m.id), ["in", "real"], "the sync's copy replaces it");
  const older = msg({ id: "older", direction: "out", internalDate: at - 600_000 });
  assert.deepEqual(mergePending([inbound, older], [sent], at + 5_000).map((m) => m.id), ["in", "older", "pending:7"], "an older outbound message is not this one");
  assert.deepEqual(mergePending([inbound], [sent], at + 16 * 60_000).map((m) => m.id), ["in"], "a send that never confirms is dropped after fifteen minutes");
});

test("sameMessages sees a new message, a body that arrived, and an image toggle, and nothing else; bodyNotice names the reason bodies did not load", async () => {
  const { sameMessages, bodyNotice } = await import("./compose");
  const base = (id: string): MessageView => ({ accountId: "a", id, threadId: "t", internalDate: 1, from: { email: "x@y.z", name: "" }, replyTo: null, to: [], cc: [], messageIdHeader: null, references: null, subject: "", snippet: "", labelIds: [], direction: "in", isAuto: false, hasAttachments: false, body: { html: "<p>hi</p>", text: null, attachments: [] }, loadImages: false });
  const a = [base("m1"), base("m2")];
  assert.equal(sameMessages(a, [base("m1"), base("m2")]), true);
  assert.equal(sameMessages(a, [base("m1"), base("m2"), base("m3")]), false, "a reply arrived");
  assert.equal(sameMessages(a, [base("m1"), { ...base("m2"), body: null }]), false, "a body went missing or arrived");
  assert.equal(sameMessages(a, [base("m1"), { ...base("m2"), loadImages: true }]), false, "Load images changed");
  assert.equal(sameMessages(a, [base("m1"), { ...base("m2"), subject: "different" }]), true, "header text alone is not a reason to reload the frames");
  assert.equal(bodyNotice({ bodiesPending: false }), null);
  assert.equal(bodyNotice({ bodiesPending: true }), "Messages not loaded.");
  assert.equal(bodyNotice({ bodiesPending: true, bodiesError: "Not signed in, so the message bodies cannot be fetched." }), "Messages not loaded. Not signed in, so the message bodies cannot be fetched.");
});

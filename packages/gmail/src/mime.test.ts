import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeBody, findBody, hasCalendarPart, listAttachments, parseAddressList, header, type GmailMessage } from "./mime.js";
import { fixtureJson } from "../test/helpers.js";

const msg = fixtureJson<GmailMessage>("nested-message.json");

test("findBody prefers html over plain across nested multipart parts", () => {
  const body = findBody(msg.payload);
  assert.equal(body.html, '<div>Here is the <b>deck</b>. <img src="cid:logo"></div>');
  assert.equal(body.text, "Here is the deck. Café", "the ISO-8859-1 part decodes through its charset");
});

test("listAttachments walks every level and marks inline parts", () => {
  const atts = listAttachments(msg.payload);
  assert.deepEqual(
    atts.map((a) => [a.filename, a.mimeType, a.inline, a.contentId, a.attachmentId]),
    [
      ["logo.png", "image/png", true, "logo", "ANGjdJ_logo"],
      ["deck.pdf", "application/pdf", false, null, "ANGjdJ_deck"],
    ]
  );
});

test("decodeBody handles base64url and header helpers read case-insensitively", () => {
  assert.equal(decodeBody("SGVsbG8_"), "Hello?");
  assert.equal(header(msg, "subject"), "Deck for Tuesday");
  assert.deepEqual(parseAddressList('"Glenn, Maya" <maya@arcforma.ai>, you@example.com'), [
    { email: "maya@arcforma.ai", name: "Glenn, Maya" },
    { email: "you@example.com", name: "" },
  ]);
  assert.equal(hasCalendarPart(msg.payload), false);
  assert.equal(hasCalendarPart({ mimeType: "multipart/mixed", parts: [{ mimeType: "text/calendar", body: { data: "" } }] }), true);
});

// ---- what counts as inline ----------------------------------------------------------------------

test("a Gmail attachment carrying a Content-ID is still an attachment", () => {
  // The real shape of a CV sent from Gmail: Content-Disposition: attachment, and a Content-ID that
  // Gmail stamps on regardless. Treating the Content-ID as proof of inline hid the file completely.
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/html", body: { data: Buffer.from("<p>Hi Oliver,</p>").toString("base64url") } },
      {
        partId: "1",
        filename: "Matthew Gallo CV.pdf",
        mimeType: "application/pdf",
        body: { attachmentId: "A1", size: 259275 },
        headers: [
          { name: "Content-Disposition", value: 'attachment; filename="Matthew Gallo CV.pdf"' },
          { name: "Content-ID", value: "<f_mtllr0hq0>" },
        ],
      },
    ],
  };
  const [cv] = listAttachments(payload as never, [], "<p>Hi Oliver,</p>");
  assert.equal(cv?.filename, "Matthew Gallo CV.pdf");
  assert.equal(cv?.inline, false, "a Content-ID does not make a CV part of the layout");
});

test("an image the HTML actually points at is inline", () => {
  const html = '<p>See <img src="cid:logo123"></p>';
  const payload = {
    mimeType: "multipart/related",
    parts: [
      { mimeType: "text/html", body: { data: Buffer.from(html).toString("base64url") } },
      { partId: "1", filename: "logo.png", mimeType: "image/png", body: { attachmentId: "A2", size: 900 }, headers: [{ name: "Content-ID", value: "<logo123>" }] },
    ],
  };
  assert.equal(listAttachments(payload as never, [], html)[0]?.inline, true);
});

test("a Content-ID nothing points at is a file, not layout", () => {
  const html = "<p>No images here.</p>";
  const payload = { parts: [{ partId: "1", filename: "photo.png", mimeType: "image/png", body: { attachmentId: "A3", size: 900 }, headers: [{ name: "Content-ID", value: "<orphan>" }] }] };
  assert.equal(listAttachments(payload as never, [], html)[0]?.inline, false);
});

test("an explicit inline disposition is inline even with no HTML to check", () => {
  const payload = { parts: [{ partId: "1", filename: "sig.png", mimeType: "image/png", body: { attachmentId: "A4", size: 90 }, headers: [{ name: "Content-Disposition", value: "inline" }] }] };
  assert.equal(listAttachments(payload as never, [], null)[0]?.inline, true);
});

test("without the HTML, a Content-ID part is treated as a real attachment", () => {
  // The safe way round: an unreferenced layout image shown as a file is untidy, a hidden CV is a
  // lost candidate.
  const payload = { parts: [{ partId: "1", filename: "cv.pdf", mimeType: "application/pdf", body: { attachmentId: "A5", size: 90 }, headers: [{ name: "Content-ID", value: "<x>" }] }] };
  assert.equal(listAttachments(payload as never, [], null)[0]?.inline, false);
});

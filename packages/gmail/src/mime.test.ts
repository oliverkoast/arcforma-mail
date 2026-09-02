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

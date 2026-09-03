import { test } from "node:test";
import assert from "node:assert/strict";
import { AttachmentError, attachmentPath, decodeBase64Url, fetchAttachment, requestFor } from "./attachments.js";
import { GmailClient } from "./client.js";
import { fakeClock, fakeTransport, token } from "../test/helpers.js";

const HELLO = Buffer.from("Hello, attachment.");
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function client(responses: Parameters<typeof fakeTransport>[0]) {
  const clock = fakeClock();
  const { transport, calls } = fakeTransport(responses);
  return { client: new GmailClient({ accessToken: token, transport, sleep: clock.sleep, now: clock.now }), calls };
}

test("fetchAttachment asks users.messages.attachments.get and decodes the bytes", async () => {
  const { client: c, calls } = client([{ status: 200, body: { size: HELLO.length, data: b64url(HELLO) } }]);
  const got = await fetchAttachment(c, { messageId: "m-1", attachmentId: "ANGjdJ_deck", size: HELLO.length });
  assert.equal(got.bytes.toString(), "Hello, attachment.");
  assert.equal(got.inline, false);
  assert.match(calls[0]!.url, /\/messages\/m-1\/attachments\/ANGjdJ_deck$/);
  assert.equal(attachmentPath("m/1", "a+b"), "messages/m%2F1/attachments/a%2Bb", "both ids are path segments, so both are encoded");
});

test("base64url decodes whatever padding it arrives with, and whitespace in the middle", () => {
  // Three lengths so every remainder class (0, 2, 3 characters over) is covered.
  for (const text of ["ab", "abc", "abcd", "Hello?~", "éè"]) {
    const raw = Buffer.from(text);
    const unpadded = b64url(raw);
    const padded = raw.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
    assert.equal(decodeBase64Url(unpadded).toString(), text, `no padding: ${text}`);
    assert.equal(decodeBase64Url(padded).toString(), text, `standard padding: ${text}`);
    assert.equal(decodeBase64Url(`${unpadded}====`).toString(), text, `too much padding: ${text}`);
  }
  assert.equal(decodeBase64Url("SGVsbG8s\r\nIGF0dGFjaG1lbnQu").toString(), "Hello, attachment.", "a line-wrapped body still decodes");
  // The two base64url substitutions, which plain base64 would reject.
  assert.deepEqual(decodeBase64Url("-_-_"), Buffer.from([0xfb, 0xff, 0xbf]));
});

test("an attachment Gmail no longer holds is a typed missing error, not an empty file", async () => {
  const { client: c } = client([{ status: 200, body: { size: 0 } }]);
  await assert.rejects(
    () => fetchAttachment(c, { messageId: "m-1", attachmentId: "gone", size: 12 }),
    (err: AttachmentError) => {
      assert.equal(err.name, "AttachmentError");
      assert.equal(err.code, "missing");
      assert.match(err.message, /removed from the message/);
      return true;
    }
  );
  // A 200 with a null body (Gmail has answered this way on a deleted part) is the same story.
  const { client: c2 } = client([{ status: 200, text: "" }]);
  await assert.rejects(() => fetchAttachment(c2, { messageId: "m-1", attachmentId: "gone" }), /no data/);
});

test("bytes that are not the length the part declared are refused", async () => {
  const { client: c } = client([{ status: 200, body: { size: 999, data: b64url(HELLO) } }]);
  await assert.rejects(
    () => fetchAttachment(c, { messageId: "m-1", attachmentId: "truncated", size: 999 }),
    (err: AttachmentError) => {
      assert.equal(err.code, "size_mismatch");
      assert.match(err.message, /18 bytes where 999 were expected/);
      return true;
    }
  );
});

test("an inline part is decoded from the data already stored, with no call to Gmail", async () => {
  const { client: c, calls } = client([]);
  const got = await fetchAttachment(c, requestFor("m-2", { attachmentId: null, size: HELLO.length, data: b64url(HELLO) }));
  assert.equal(got.bytes.toString(), "Hello, attachment.");
  assert.equal(got.inline, true);
  assert.equal(calls.length, 0, "nothing goes over the network for a part that carried its own bytes");
});

test("a part with neither an id nor data says so rather than calling Gmail with an empty id", async () => {
  const { client: c, calls } = client([]);
  await assert.rejects(
    () => fetchAttachment(c, { messageId: "m-3", attachmentId: null, data: null }),
    (err: AttachmentError) => {
      assert.equal(err.code, "no_source");
      return true;
    }
  );
  assert.equal(calls.length, 0);
});

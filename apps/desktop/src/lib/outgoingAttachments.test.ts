import { test } from "node:test";
import assert from "node:assert/strict";
import { addAttachments, checkAttachments, encodedSize, formatBytes, GMAIL_LIMIT_BYTES } from "./outgoingAttachments";

const file = (name: string, size: number, path = `/tmp/${name}`) => ({ path, name, size, mimeType: "application/pdf" });

test("the limit is checked against the encoded size, which is what the server counts", () => {
  // A 20 MB file is under 25 MB on disk and over it on the wire. Checking the disk size would let
  // the writer press Send and learn about it from a bounce.
  const twenty = 20 * 1024 * 1024;
  assert.ok(twenty < GMAIL_LIMIT_BYTES);
  assert.ok(encodedSize(twenty) > GMAIL_LIMIT_BYTES);
  const check = checkAttachments([file("deck.pdf", twenty)]);
  assert.equal(check.ok, false);
  assert.match(check.problem, /25 MB/);
  assert.match(check.problem, /send a link instead/, "it says what to do, not only what is wrong");
});

test("an ordinary deck is fine", () => {
  const check = checkAttachments([file("deck.pdf", 4 * 1024 * 1024), file("notes.pdf", 200 * 1024)]);
  assert.equal(check.ok, true);
  assert.equal(check.problem, "");
  assert.equal(check.totalBytes, 4 * 1024 * 1024 + 200 * 1024);
});

test("no attachments is not a problem", () => {
  assert.deepEqual(checkAttachments([]), { ok: true, totalBytes: 0, problem: "" });
});

test("sizes read the way a person would say them", () => {
  assert.equal(formatBytes(900), "900 B");
  assert.equal(formatBytes(259275), "253 KB");
  assert.equal(formatBytes(4 * 1024 * 1024), "4 MB", "no trailing .0 on a round number");
  assert.equal(formatBytes(1.5 * 1024 * 1024), "1.5 MB", "one decimal where it says something");
});

test("the same file picked twice is attached once", () => {
  const have = [file("deck.pdf", 10)];
  assert.equal(addAttachments(have, [file("deck.pdf", 10)]).length, 1);
  assert.equal(addAttachments(have, [file("other.pdf", 10, "/tmp/other.pdf")]).length, 2);
});

test("two different files that share a name are both kept", () => {
  // Same name from two folders is a normal thing to do, and dropping one silently loses a file.
  const have = [file("deck.pdf", 10, "/a/deck.pdf")];
  assert.equal(addAttachments(have, [file("deck.pdf", 10, "/b/deck.pdf")]).length, 2);
});

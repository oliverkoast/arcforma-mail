import { test } from "node:test";
import assert from "node:assert/strict";
import { partHasAttachment } from "./mail-headers.js";

// ---- what counts as an attachment ---------------------------------------------------------------

test("an inline image is part of the message, not a file attached to it", () => {
  // Newsletters are built from inline images. Counting them lit the paperclip on rows with nothing
  // to open and filled the With attachments view with mail that has no attachments.
  const inlineByDisposition = { filename: "hero.png", body: { attachmentId: "a1" }, headers: [{ name: "Content-Disposition", value: "inline; filename=hero.png" }] };
  const inlineByCid = { filename: "logo.png", body: { attachmentId: "a2" }, headers: [{ name: "Content-ID", value: "<logo@news>" }] };
  assert.equal(partHasAttachment({ parts: [inlineByDisposition] } as never), false);
  assert.equal(partHasAttachment({ parts: [inlineByCid] } as never), false);
});

test("a real attachment still counts, alongside inline images", () => {
  const inline = { filename: "logo.png", body: { attachmentId: "a1" }, headers: [{ name: "Content-ID", value: "<logo@news>" }] };
  const real = { filename: "resume.pdf", body: { attachmentId: "a2" }, headers: [{ name: "Content-Disposition", value: "attachment; filename=resume.pdf" }] };
  assert.equal(partHasAttachment({ parts: [inline, real] } as never), true);
});

test("a part with no headers at all is treated as a real attachment", () => {
  // Gmail metadata omits part headers on some responses. Missing information must not silently
  // hide a file: the failure that matters is not showing one that is there.
  assert.equal(partHasAttachment({ parts: [{ filename: "notes.txt", body: { attachmentId: "a1" } }] } as never), true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { partHasAttachment } from "./mail-headers.js";

// ---- what counts as an attachment ---------------------------------------------------------------

test("an image marked Content-Disposition: inline is part of the message", () => {
  const inlineByDisposition = { filename: "hero.png", body: { attachmentId: "a1" }, headers: [{ name: "Content-Disposition", value: "inline; filename=hero.png" }] };
  assert.equal(partHasAttachment({ parts: [inlineByDisposition] } as never), false);
});

test("a Content-ID does not make a file part of the message", () => {
  // Gmail stamps one on every attachment of anything composed in Gmail. Reading it as inline hid a
  // CV from the paperclip and from the With attachments view while it sat in the database.
  const cv = { filename: "cv.pdf", body: { attachmentId: "a2" }, headers: [{ name: "Content-Disposition", value: "attachment; filename=cv.pdf" }, { name: "Content-ID", value: "<f_mtllr0hq0>" }] };
  const bareCid = { filename: "photo.png", body: { attachmentId: "a3" }, headers: [{ name: "Content-ID", value: "<x>" }] };
  assert.equal(partHasAttachment({ parts: [cv] } as never), true);
  assert.equal(partHasAttachment({ parts: [bareCid] } as never), true, "metadata cannot check the HTML, so it errs toward showing the file");
});

test("a real attachment still counts, alongside inline images", () => {
  const inline = { filename: "logo.png", body: { attachmentId: "a1" }, headers: [{ name: "Content-Disposition", value: "inline" }] };
  const real = { filename: "resume.pdf", body: { attachmentId: "a2" }, headers: [{ name: "Content-Disposition", value: "attachment; filename=resume.pdf" }] };
  assert.equal(partHasAttachment({ parts: [inline, real] } as never), true);
});

test("a part with no headers at all is treated as a real attachment", () => {
  // Gmail metadata omits part headers on some responses. Missing information must not silently
  // hide a file: the failure that matters is not showing one that is there.
  assert.equal(partHasAttachment({ parts: [{ filename: "notes.txt", body: { attachmentId: "a1" } }] } as never), true);
});

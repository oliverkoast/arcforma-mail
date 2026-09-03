import { test } from "node:test";
import assert from "node:assert/strict";
import { attachmentMarker } from "./attachments";

const file = (over: { inline?: boolean } = {}) => ({ key: "k", filename: "a.pdf", mimeType: "application/pdf", size: 10, inline: false, preview: "download" as const, ...over });

test("a loaded body is counted exactly, inline images excluded", () => {
  const body = { html: null, text: null, attachments: [file(), file({ inline: true }), file()] };
  assert.deepEqual(attachmentMarker({ body, hasAttachments: true } as never), { count: 2, exact: true });
});

test("a body of nothing but inline images shows no marker at all", () => {
  // hasAttachments is true for these, so trusting the flag would promise files and then show none.
  const body = { html: "<img>", text: null, attachments: [file({ inline: true })] };
  assert.deepEqual(attachmentMarker({ body, hasAttachments: true } as never), { count: 0, exact: true });
});

test("before the body loads the flag still says something, marked inexact", () => {
  const m = attachmentMarker({ body: null, hasAttachments: true } as never);
  assert.equal(m.count, 1);
  assert.equal(m.exact, false, "so the count is not printed as if it were the real number");
});

test("no body and no flag is no marker", () => {
  assert.deepEqual(attachmentMarker({ body: null, hasAttachments: false } as never), { count: 0, exact: false });
});

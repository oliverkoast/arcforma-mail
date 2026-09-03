import { test } from "node:test";
import assert from "node:assert/strict";
import { QUOTE_FORBID_TAGS, QUOTE_FORBID_ATTR } from "./quote-policy";

// The quoted history in a reply is rendered in the app itself, not in the sandboxed frame the
// reading pane uses. Anything that fetches a URL from there fires the moment Reply is pressed,
// which tells the sender the mail was read and that a reply is being written. The reading pane's
// per-sender image setting cannot express that, so nothing that loads is allowed here at all.
test("nothing that can fetch a remote URL survives in a quoted reply", () => {
  for (const tag of ["img", "picture", "source", "video", "audio", "svg", "canvas", "track", "iframe", "object", "embed"]) {
    assert.ok(QUOTE_FORBID_TAGS.includes(tag), `${tag} must be stripped from quoted history`);
  }
  for (const attr of ["srcset", "background", "poster", "style"]) {
    assert.ok(QUOTE_FORBID_ATTR.includes(attr), `${attr} can load a remote URL and must be stripped`);
  }
});

test("nothing that can execute or submit survives either", () => {
  for (const tag of ["script", "form", "input", "button", "link", "meta", "base", "style"]) {
    assert.ok(QUOTE_FORBID_TAGS.includes(tag), `${tag} must be stripped from quoted history`);
  }
  assert.ok(QUOTE_FORBID_ATTR.includes("formaction"));
  assert.ok(QUOTE_FORBID_ATTR.includes("ping"));
});

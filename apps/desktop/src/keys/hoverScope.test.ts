import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeForPointer } from "./hoverScope";

test("pointer over a row makes the list the key target, over the reading pane the open thread", () => {
  assert.equal(scopeForPointer("thread", true, false), "list");
  assert.equal(scopeForPointer("list", false, true), "thread");
  assert.equal(scopeForPointer("list", false, false), "list");
  assert.equal(scopeForPointer("thread", false, false), "thread");
});

test("typing and overlay scopes ignore the pointer", () => {
  for (const s of ["compose", "search", "ask", "settings", "snippets", "popover", "sendLater", "sidebar"] as const) {
    assert.equal(scopeForPointer(s, true, false), s);
    assert.equal(scopeForPointer(s, false, true), s);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeForPointer } from "./hoverScope";
import type { Scope } from "./keymap";

// The rule is now the absence of a rule, and that is worth pinning: the previous behaviour looked
// helpful and broke two things at once, so a future change back should have to delete this test.
test("where the mouse rests never changes what the keys do", () => {
  const scopes: Scope[] = ["list", "thread", "compose", "search", "ask", "settings", "snippets", "popover", "sendLater", "sidebar", "palette", "setup", "global"];
  for (const s of scopes) assert.equal(scopeForPointer(s), s);
});

test("reading a thread keeps the keys that only exist while reading", () => {
  // Escape, O and 1/2/3 are bound in "thread" and not in "list". A pointer parked over the list used
  // to move the scope and take them away with nothing on screen to explain it.
  assert.equal(scopeForPointer("thread"), "thread");
});

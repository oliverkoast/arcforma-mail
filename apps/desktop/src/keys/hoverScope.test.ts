import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeForPointer } from "./hoverScope";
import type { Scope } from "./keymap";

// Hovering a row selects it, in ThreadList. What must not come back is the pointer also moving the
// key scope, which quietly unbound Escape, O and 1/2/3 whenever the mouse sat over the list.
test("the pointer never changes which scope the keys are read from", () => {
  const scopes: Scope[] = ["list", "thread", "compose", "search", "ask", "settings", "snippets", "popover", "sendLater", "sidebar", "palette", "setup", "global"];
  for (const s of scopes) assert.equal(scopeForPointer(s), s);
});

test("reading a thread keeps the keys that only exist while reading", () => {
  // Escape, O and 1/2/3 are bound in "thread" and not in "list". A pointer parked over the list used
  // to move the scope and take them away with nothing on screen to explain it.
  assert.equal(scopeForPointer("thread"), "thread");
});

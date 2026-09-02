import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBinding, type KeyLike } from "./dispatcher";
import { KEYMAP } from "./keymap";

function key(k: string, mods: Partial<KeyLike> = {}): KeyLike {
  return { key: k, metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, ...mods };
}

test("list scope: plain letters drive the list", () => {
  assert.equal(resolveBinding("list", key("j"), false)?.action, "next");
  assert.equal(resolveBinding("list", key("e"), false)?.action, "archive");
  assert.equal(resolveBinding("list", key("c"), false)?.action, "compose");
  assert.equal(resolveBinding("list", key("Enter"), false)?.action, "open");
  assert.equal(resolveBinding("list", key("z"), false)?.action, "undo");
});

test("compose scope: plain letters never trigger list actions, even off the editor", () => {
  for (const k of ["j", "k", "e", "c", "h", "s", "r", "a", "f", "z", "1", "/"]) {
    assert.equal(resolveBinding("compose", key(k), true), null, `${k} in the editor`);
    assert.equal(resolveBinding("compose", key(k), false), null, `${k} on a compose button`);
  }
  assert.equal(resolveBinding("compose", key("Escape"), true)?.action, "closeCompose");
  assert.equal(resolveBinding("compose", key("Tab"), true)?.action, "acceptDraft");
  assert.equal(resolveBinding("compose", key("Enter", { metaKey: true }), true)?.action, "send");
  assert.equal(resolveBinding("compose", key("Enter", { metaKey: true, shiftKey: true }), true)?.action, "sendLater");
  assert.equal(resolveBinding("compose", key(";", { metaKey: true }), true)?.action, "snippets");
  assert.equal(resolveBinding("compose", key("Enter"), true), null, "plain Enter stays in the editor");
});

test("typing in the search field only leaves Escape and Enter", () => {
  assert.equal(resolveBinding("search", key("j"), true), null);
  assert.equal(resolveBinding("search", key("Escape"), true)?.action, "leaveSearch");
  assert.equal(resolveBinding("search", key("Enter"), true)?.action, "runSearch");
});

test("global Cmd chords work everywhere, including the editor", () => {
  for (const scope of ["list", "thread", "compose", "ask", "settings"] as const) {
    assert.equal(resolveBinding(scope, key("a", { metaKey: true, shiftKey: true }), true)?.action, "ask", scope);
    assert.equal(resolveBinding(scope, key(",", { metaKey: true }), true)?.action, "settings", scope);
    assert.equal(resolveBinding(scope, key("c", { metaKey: true, shiftKey: true }), false)?.action, "toggleCalendar", scope);
  }
  assert.equal(resolveBinding("list", key("a", { metaKey: true, shiftKey: true, ctrlKey: true }), false), null, "Ctrl breaks the chord");
});

test("D and W drive the queues in the list and the thread, with labels in the keymap", () => {
  for (const scope of ["list", "thread"] as const) {
    assert.equal(resolveBinding(scope, key("d"), false)?.action, "toggleDaily", scope);
    assert.equal(resolveBinding(scope, key("w"), false)?.action, "toggleWeekly", scope);
    assert.equal(resolveBinding(scope, key("D", { shiftKey: true }), false), null, "Shift+D is not D");
  }
  const daily = KEYMAP.find((b) => b.action === "toggleDaily");
  const weekly = KEYMAP.find((b) => b.action === "toggleWeekly");
  assert.equal(daily?.label, "Add to or remove from Daily 0");
  assert.equal(weekly?.label, "Add to or remove from Weekly 0");
});

test("inside the snooze popover W keeps its next-week meaning and D picks a date: the popover scope wins", () => {
  assert.equal(resolveBinding("popover", key("w"), false)?.action, "snoozeNextWeek");
  assert.equal(resolveBinding("popover", key("d"), false)?.action, "snoozePick");
  assert.equal(resolveBinding("sendLater", key("w"), false)?.action, "sendNextMonday", "send later keeps its own W");
  assert.equal(resolveBinding("sendLater", key("d"), false)?.action, "sendPick");
  assert.equal(resolveBinding("compose", key("d"), true), null, "typing a d in the editor never touches a queue");
  assert.equal(resolveBinding("compose", key("w"), false), null);
  assert.equal(resolveBinding("search", key("d"), true), null);
});

test("popover and send-later scopes take their single letters", () => {
  assert.equal(resolveBinding("popover", key("t"), false)?.action, "snoozeTomorrow");
  assert.equal(resolveBinding("popover", key("j"), false), null);
  assert.equal(resolveBinding("sendLater", key("t"), false)?.action, "sendTomorrow");
  assert.equal(resolveBinding("sendLater", key("w"), false)?.action, "sendNextMonday");
  assert.equal(resolveBinding("sendLater", key("Escape"), false)?.action, "closeSendLater");
  assert.equal(resolveBinding("sendLater", key("e"), false), null);
});

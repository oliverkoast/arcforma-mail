import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBinding, type KeyLike } from "./dispatcher";
import { KEYMAP } from "./keymap";
import { keyLabel } from "./keyLabel";

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
  assert.equal(resolveBinding("compose", key("l", { metaKey: true, shiftKey: true }), true)?.action, "sendLater");
  assert.equal(resolveBinding("compose", key("l"), true), null, "the bare letter still types");
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

test("U unsubscribes in the list and the thread only: never while typing, never in a popover", () => {
  for (const scope of ["list", "thread"] as const) {
    const b = resolveBinding(scope, key("u"), false);
    assert.equal(b?.action, "unsubscribe", scope);
    assert.equal(b?.label, "Unsubscribe and archive");
  }
  assert.equal(resolveBinding("list", key("u"), true), null, "a u typed into a field is text");
  assert.equal(resolveBinding("compose", key("u"), true), null);
  assert.equal(resolveBinding("popover", key("u"), false), null);
  assert.equal(resolveBinding("search", key("u"), true), null);
  assert.equal(resolveBinding("list", key("U", { shiftKey: true }), false), null, "Shift+U is not U");
  assert.deepEqual(KEYMAP.filter((b) => b.action === "unsubscribe").map((b) => b.scope).sort(), ["list", "thread"]);
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

test("Shift+E moves a thread back to the inbox in the list and the thread; E alone still marks done", () => {
  for (const scope of ["list", "thread"] as const) {
    assert.equal(resolveBinding(scope, key("e"), false)?.action, "archive", scope);
    assert.equal(resolveBinding(scope, key("E", { shiftKey: true }), false)?.action, "moveToInbox", scope);
  }
  assert.equal(resolveBinding("compose", key("E", { shiftKey: true }), true), null, "never while typing");
  assert.equal(resolveBinding("popover", key("E", { shiftKey: true }), false), null, "never behind the snooze popover");
  const back = KEYMAP.filter((b) => b.action === "moveToInbox");
  assert.deepEqual(back.map((b) => b.scope), ["list", "thread"]);
  for (const b of back) {
    assert.equal(b.label, "Move back to inbox");
    assert.equal(b.shift, true);
  }
  assert.equal(keyLabel("moveToInbox"), "Shift+E");
});

test("O folds and unfolds a thread's history, and only while a thread is open", () => {
  assert.equal(resolveBinding("thread", key("o"), false)?.action, "toggleAllMessages");
  assert.equal(resolveBinding("list", key("o"), false), null, "nothing to fold in a list");
  assert.equal(resolveBinding("compose", key("o"), true), null, "an O typed into a reply is an O");
  const fold = KEYMAP.filter((b) => b.action === "toggleAllMessages");
  assert.equal(fold.length, 1);
  assert.equal(fold[0]?.scope, "thread");
  assert.equal(fold[0]?.label, "Expand or collapse the earlier messages");
});

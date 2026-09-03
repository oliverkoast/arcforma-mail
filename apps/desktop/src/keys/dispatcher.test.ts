import { test } from "node:test";
import assert from "node:assert/strict";
import { armsGoTo, resolveBinding, type KeyLike } from "./dispatcher";
import { GO_TO, resolveGoTo } from "./keymap";
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

test("U marks read or unread in the list and the thread only: never while typing, never in a popover", () => {
  for (const scope of ["list", "thread"] as const) {
    const b = resolveBinding(scope, key("u"), false);
    assert.equal(b?.action, "toggleRead", scope);
    assert.equal(b?.label, "Mark read or unread");
  }
  assert.equal(resolveBinding("list", key("u"), true), null, "a u typed into a field is text");
  assert.equal(resolveBinding("compose", key("u"), true), null);
  assert.equal(resolveBinding("popover", key("u"), false), null);
  assert.equal(resolveBinding("search", key("u"), true), null);
  assert.deepEqual(KEYMAP.filter((b) => b.action === "toggleRead").map((b) => b.scope).sort(), ["list", "thread"]);
});

test("Shift+U is unsubscribe, which U used to be", () => {
  // Moved to make room for read and unread. Plain U must never reach it again by accident: the two
  // are not comparable, one is reversible with the same key and the other sends a request that
  // cannot be recalled.
  for (const scope of ["list", "thread"] as const) {
    assert.equal(resolveBinding(scope, key("u", { shiftKey: true }), false)?.action, "unsubscribe", scope);
    assert.notEqual(resolveBinding(scope, key("u"), false)?.action, "unsubscribe", scope);
  }
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

// ---- G, then a letter -------------------------------------------------------------------------
// The danger of a prefix chord is that its second key already means something on its own. G then E
// must go to Done, never archive the selected thread, or the chord is worse than not having it.

const keyEvent = (over: Partial<KeyLike> & { key: string }): KeyLike => ({ metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, ...over });

test("G arms only where a plain letter is a command", () => {
  assert.equal(armsGoTo("list", keyEvent({ key: "g" }), false), true);
  assert.equal(armsGoTo("thread", keyEvent({ key: "g" }), false), true);
  assert.equal(armsGoTo("list", keyEvent({ key: "g" }), true), false, "not while a field has focus");
  assert.equal(armsGoTo("compose", keyEvent({ key: "g" }), false), false, "not while writing a message");
  assert.equal(armsGoTo("search", keyEvent({ key: "g" }), false), false);
  assert.equal(armsGoTo("setup", keyEvent({ key: "g" }), false), false);
  assert.equal(armsGoTo("list", keyEvent({ key: "g", metaKey: true }), false), false, "Cmd+G is not the prefix");
  assert.equal(armsGoTo("list", keyEvent({ key: "G", shiftKey: true }), false), false);
});

test("every go-to letter names a real view, and none is claimed twice", () => {
  const keys = GO_TO.map((g) => g.key);
  assert.equal(new Set(keys).size, keys.length, "two destinations cannot share a letter");
  for (const g of GO_TO) {
    assert.equal(g.key, g.key.toLowerCase(), "the table is matched case-insensitively against lower case");
    assert.ok(g.label.length > 0);
    assert.equal(resolveGoTo(g.key.toUpperCase())?.view, g.view, "shift must not break the chord");
  }
});

test("the two Oliver named, and the letters that mirror their actions", () => {
  assert.equal(resolveGoTo("i")?.view, "inbox");
  assert.equal(resolveGoTo("t")?.view, "sent");
  // E marks done, H snoozes, S stars, so those letters go where those actions send mail.
  assert.equal(resolveGoTo("e")?.view, "archive");
  assert.equal(resolveGoTo("h")?.view, "snoozed");
  assert.equal(resolveGoTo("s")?.view, "starred");
  assert.equal(resolveGoTo("u")?.view, "unread");
});

test("a letter that means nothing after G goes nowhere", () => {
  assert.equal(resolveGoTo("z"), null);
  assert.equal(resolveGoTo(""), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeFor, type ScopeState } from "./scope";
import { resolveBinding } from "./dispatcher";

function state(over: Partial<ScopeState> = {}): ScopeState {
  return { settingsOpen: false, ask: { open: false }, compose: null, inlineCollapsed: false, snippetPickerOpen: false, sendLaterOpen: false, popover: null, sidebarMenu: null, open: null, ...over };
}

test("Escape closes the topmost surface: popover, then settings, then Ask, then compose, then the reading pane", () => {
  const everything = state({ popover: "snooze", settingsOpen: true, ask: { open: true }, compose: {}, snippetPickerOpen: true, sendLaterOpen: true, open: {} });
  const order: Array<[string, Partial<ScopeState>]> = [
    ["popover", { popover: null }],
    ["settings", { settingsOpen: false }],
    ["ask", { ask: { open: false } }],
    ["snippets", { snippetPickerOpen: false }],
    ["sendLater", { sendLaterOpen: false }],
    ["compose", { compose: null }],
    ["thread", { open: null }],
    ["list", {}],
  ];
  let s = everything;
  for (const [expected, close] of order) {
    assert.equal(scopeFor(s), expected);
    const b = resolveBinding(scopeFor(s), { key: "Escape", metaKey: false, shiftKey: false, altKey: false, ctrlKey: false }, true);
    if (expected === "list") assert.equal(b, null, "nothing left to close");
    else assert.ok(b, `Escape resolves in ${expected}`);
    s = { ...s, ...close };
  }
});

test("a snooze popover over an open compose takes Escape first, and plain letters still stay out of the editor", () => {
  const s = state({ compose: {}, popover: "snooze" });
  assert.equal(scopeFor(s), "popover");
  assert.equal(resolveBinding("popover", { key: "Escape", metaKey: false, shiftKey: false, altKey: false, ctrlKey: false }, true)?.action, "closePopover");
  assert.equal(resolveBinding("popover", { key: "t", metaKey: false, shiftKey: false, altKey: false, ctrlKey: false }, true), null, "typing in the editor never snoozes");
  assert.equal(resolveBinding("popover", { key: "t", metaKey: false, shiftKey: false, altKey: false, ctrlKey: false }, false)?.action, "snoozeTomorrow");
});

test("the sidebar menu takes Escape and nothing else: no snooze letters, no list letters, Cmd chords still work", () => {
  const s = state({ sidebarMenu: { kind: "add" }, open: {} });
  assert.equal(scopeFor(s), "sidebar");
  const key = (k: string, meta = false) => ({ key: k, metaKey: meta, shiftKey: false, altKey: false, ctrlKey: false });
  assert.equal(resolveBinding("sidebar", key("Escape"), false)?.action, "closeSidebarMenu");
  for (const k of ["t", "w", "d", "r", "j", "e", "h"]) assert.equal(resolveBinding("sidebar", key(k), false), null, `${k} does nothing while the sidebar menu is open`);
  assert.equal(resolveBinding("sidebar", key(",", true), true)?.action, "settings");
  assert.equal(scopeFor(state({ sidebarMenu: { kind: "add" }, popover: "snooze" })), "popover", "a snooze popover on top still wins");
});

test("an inline reply owns the keys while its editor has focus; collapsed to its strip, J, K, R, and Escape go back to the thread", () => {
  const key = (k: string, meta = false, shift = false) => ({ key: k, metaKey: meta, shiftKey: shift, altKey: false, ctrlKey: false });
  const typing = state({ compose: { mode: "reply" }, open: {} });
  assert.equal(scopeFor(typing), "compose", "the box is docked in the reading pane, but the scope is compose all the same");
  for (const k of ["j", "k", "e", "r", "a", "f", "c", "h", "s", "d", "w", "1", "2", "3", "/"]) {
    assert.equal(resolveBinding("compose", key(k), true), null, `${k} typed into the inline editor is text, never a list action`);
    assert.equal(resolveBinding("compose", key(k), false), null, `${k} with focus elsewhere in the box still never reaches the list`);
  }
  assert.equal(resolveBinding("compose", key("Escape"), true)?.action, "closeCompose", "Escape collapses the box to its strip");
  assert.equal(resolveBinding("compose", key("Tab"), true)?.action, "acceptDraft");
  assert.equal(resolveBinding("compose", key("Enter", true), true)?.action, "send");
  assert.equal(resolveBinding("compose", key("Enter", true, true), true)?.action, "sendLater");
  assert.equal(resolveBinding("compose", key(";", true), true)?.action, "snippets");

  const strip = state({ compose: { mode: "reply" }, inlineCollapsed: true, open: {} });
  assert.equal(scopeFor(strip), "thread", "a collapsed inline reply hands the keys back to the thread");
  assert.equal(resolveBinding("thread", key("j"), false)?.action, "next");
  assert.equal(resolveBinding("thread", key("k"), false)?.action, "prev");
  assert.equal(resolveBinding("thread", key("r"), false)?.action, "reply", "R reopens the strip");
  assert.equal(resolveBinding("thread", key("Escape"), false)?.action, "close", "Escape again leaves the thread");
  assert.equal(scopeFor(state({ compose: { mode: "reply" }, inlineCollapsed: true, open: null })), "list", "the thread closed behind a collapsed reply: back to the list");
  assert.equal(scopeFor(state({ compose: { mode: "reply" }, inlineCollapsed: true, sendLaterOpen: true, open: {} })), "thread", "a stale send-later flag never traps the keys under a strip");
  assert.equal(scopeFor(state({ compose: { mode: "reply" }, popover: "snooze", open: {} })), "popover", "a snooze popover still sits above the inline box");
});

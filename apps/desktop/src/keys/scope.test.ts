import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeFor, type ScopeState } from "./scope";
import { resolveBinding } from "./dispatcher";

function state(over: Partial<ScopeState> = {}): ScopeState {
  return { settingsOpen: false, ask: { open: false }, compose: null, snippetPickerOpen: false, sendLaterOpen: false, popover: null, sidebarMenu: null, open: null, ...over };
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

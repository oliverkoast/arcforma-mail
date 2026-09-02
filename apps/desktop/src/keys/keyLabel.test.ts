import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBinding, keyLabel } from "./keyLabel";

test("keyLabel reads the keymap and formats macOS style", () => {
  assert.equal(keyLabel("archive"), "E");
  assert.equal(keyLabel("send"), "Cmd+Enter");
  assert.equal(keyLabel("sendLater"), "Cmd+Shift+L");
  assert.equal(keyLabel("ask"), "Cmd+Shift+A");
  assert.equal(keyLabel("toggleReadingPane"), "Cmd+\\");
  assert.equal(keyLabel("snippets"), "Cmd+;");
  assert.equal(keyLabel("settings"), "Cmd+,");
  assert.equal(keyLabel("closeCompose"), "Esc");
  assert.equal(keyLabel("acceptDraft"), "Tab");
  assert.equal(keyLabel("open"), "Enter");
  assert.equal(keyLabel("instantReply1"), "1");
});

test("keyLabel prefers the binding for the given scope and returns null for an unbound action", () => {
  assert.equal(keyLabel("undo", "popover"), "Z");
  assert.equal(keyLabel("sendTomorrow", "sendLater"), "T");
  assert.equal(keyLabel("nothingBoundHere"), null);
});

test("formatBinding orders modifiers Cmd, Option, Shift", () => {
  assert.equal(formatBinding({ key: "k", meta: true, alt: true, shift: true }), "Cmd+Option+Shift+K");
  assert.equal(formatBinding({ key: "ArrowDown" }), "Down");
});

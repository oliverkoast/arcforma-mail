import { test } from "node:test";
import assert from "node:assert/strict";
import { setupIsDone } from "./done.js";

test("a signed-in account means setup is done, whatever the flag says", () => {
  // The exact state of 2026-09-09: flag cleared by reopening setup, both accounts ok and syncing.
  assert.equal(setupIsDone(false, [{ auth_state: "ok" }, { auth_state: "signed_out" }, { auth_state: "ok" }]), true);
});

test("the stored answer stands on its own", () => {
  assert.equal(setupIsDone(true, []), true);
  assert.equal(setupIsDone(true, [{ auth_state: "signed_out" }]), true);
});

test("nothing signed in and no stored answer is a first run", () => {
  assert.equal(setupIsDone(false, [{ auth_state: "signed_out" }, { auth_state: "expired" }]), false);
  assert.equal(setupIsDone(undefined, []), false);
});

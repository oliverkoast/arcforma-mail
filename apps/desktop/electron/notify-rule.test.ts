import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldBanner } from "./notify-rule.js";

const base = { enabled: true, smoke: false, split: "important", type: null, direction: "in" as const, internalDate: 2_000, startedAt: 1_000, seen: false };

test("important mail and calendar mail that arrived after launch earn a banner, once", () => {
  assert.equal(shouldBanner(base), true);
  assert.equal(shouldBanner({ ...base, split: "other", type: "calendar" }), true);
  assert.equal(shouldBanner({ ...base, seen: true }), false, "announced once");
});

test("nothing else does", () => {
  assert.equal(shouldBanner({ ...base, split: "other", type: "newsletters" }), false);
  assert.equal(shouldBanner({ ...base, direction: "out" }), false, "your own mail is not news");
  assert.equal(shouldBanner({ ...base, internalDate: 500 }), false, "mail from before launch is not replayed");
  assert.equal(shouldBanner({ ...base, enabled: false }), false);
  assert.equal(shouldBanner({ ...base, smoke: true }), false, "a smoke run never notifies");
});

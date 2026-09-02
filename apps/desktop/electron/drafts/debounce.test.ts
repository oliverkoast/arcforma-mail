import { test } from "node:test";
import assert from "node:assert/strict";
import { MIRROR_QUIET_MS, MirrorDebounce } from "./debounce.js";

test("an edit fires two seconds after the last keystroke, not after the first", () => {
  const d = new MirrorDebounce();
  assert.equal(MIRROR_QUIET_MS, 2000);
  d.touch(1, 0);
  d.touch(1, 500);
  d.touch(1, 1200);
  assert.deepEqual(d.take(2000), [], "the first keystroke's deadline passed, but typing went on");
  assert.equal(d.next(), 3200);
  assert.deepEqual(d.take(3199), []);
  assert.deepEqual(d.take(3200), [1]);
  assert.equal(d.next(), null);
  assert.deepEqual(d.take(9000), [], "fired once");
});

test("a flush fires now, and never sooner than two seconds after the previous fire for the same draft", () => {
  const d = new MirrorDebounce();
  d.touch(1, 0);
  assert.equal(d.touch(1, 300, true), 300, "Esc while typing: now");
  assert.deepEqual(d.take(300), [1]);
  assert.equal(d.touch(1, 900, true), 2300, "a second flush inside the gap waits for it");
  assert.deepEqual(d.take(2299), []);
  assert.deepEqual(d.take(2300), [1]);
  assert.equal(d.touch(1, 5000, true), 5000, "well past the gap: now again");
});

test("a flush already waiting is not pushed later by a plain edit, and a plain edit after a fire keeps its own trailing delay", () => {
  const d = new MirrorDebounce();
  d.touch(1, 100);
  d.touch(1, 200, true);
  assert.equal(d.next(), 200);
  d.touch(1, 250, true);
  assert.equal(d.next(), 200, "the earlier flush stands");
  assert.deepEqual(d.take(200), [1]);
  d.touch(1, 1000);
  assert.equal(d.next(), 3000, "trailing from the edit, which is already past the gap");
});

test("drafts are independent, fire in due order, and cancel drops one without touching the rest", () => {
  const d = new MirrorDebounce(1000);
  d.touch(2, 0);
  d.touch(1, 100);
  d.touch(3, 200, true);
  assert.equal(d.next(), 200);
  assert.deepEqual(d.take(1100), [3, 2, 1]);
  d.touch(4, 2000);
  d.touch(5, 2000);
  assert.equal(d.cancel(4), true);
  assert.equal(d.cancel(4), false);
  assert.deepEqual(d.pending(), [5]);
  assert.deepEqual(d.take(3000), [5]);
});

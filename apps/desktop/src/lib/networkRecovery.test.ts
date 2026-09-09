import { test } from "node:test";
import assert from "node:assert/strict";
import { installNetworkRecovery } from "./networkRecovery";

test("each reconnect retries, including after failure, and unmount removes the listener", async () => {
  const target = new EventTarget();
  let attempts = 0;
  const uninstall = installNetworkRecovery(target, async () => {
    if (++attempts === 1) throw new Error("still offline");
  });
  target.dispatchEvent(new Event("offline"));
  assert.equal(attempts, 0);
  target.dispatchEvent(new Event("online"));
  await Promise.resolve();
  target.dispatchEvent(new Event("online"));
  assert.equal(attempts, 2);
  uninstall();
  target.dispatchEvent(new Event("online"));
  assert.equal(attempts, 2);
});

import { retryMissingContent } from "./networkRecovery";

test("missing content keeps retrying without overlapping a slow fetch, and stops when the reader closes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  let release!: () => void;
  const stop = retryMissingContent(async () => {
    attempts++;
    if (attempts === 1) throw new Error("offline");
    await new Promise<void>((r) => { release = r; });
  });
  t.after(stop);
  t.mock.timers.tick(30_000);
  await new Promise<void>((r) => setImmediate(r));
  t.mock.timers.tick(30_000);
  assert.equal(attempts, 2);
  t.mock.timers.tick(90_000);
  assert.equal(attempts, 2, "a slow fetch never overlaps another");
  stop();
  release();
  await new Promise<void>((r) => setImmediate(r));
  t.mock.timers.tick(30_000);
  assert.equal(attempts, 2, "finishing after cleanup cannot restart retries");
});

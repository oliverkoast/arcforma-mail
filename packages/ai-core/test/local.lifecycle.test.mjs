import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalModel } from "../src/local.mjs";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-llama.mjs");

test("a slow exit from a stopped server never orphans the one started after it", { timeout: 10_000 }, async () => {
  const lm = new LocalModel({ binary: FAKE, model: FAKE, idleMinutes: 5 });
  let first, second;
  try {
    await lm.ensure();
    first = lm.child;
    lm.stop();
    await lm.ensure();
    second = lm.child;
    assert.notEqual(second, first);
    // The first process exits now, a second after its SIGTERM.
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(lm.child, second, "the old exit must not clear the new process");
    assert.equal(lm.status(), "ok");
  } finally {
    for (const c of [first, second]) try { c?.kill("SIGKILL"); } catch {}
  }
});

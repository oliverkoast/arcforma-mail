import { test } from "node:test";
import assert from "node:assert/strict";
import { startingSplit } from "./startView";

test("the app opens on Important when asked, and on everything otherwise", () => {
  assert.equal(startingSplit({ startSplit: "important" }), "important");
  assert.equal(startingSplit({ startSplit: "everything" }), null);
});

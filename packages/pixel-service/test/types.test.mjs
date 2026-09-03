// The declaration file is hand-written, so nothing but this test stops it from
// drifting away from the code it describes. It checks the one kind of drift that
// actually happens: an export added, removed, or renamed on one side only.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as pixelService from "../src/index.mjs";

const declared = new Set(
  [...readFileSync(fileURLToPath(new URL("../src/index.d.mts", import.meta.url)), "utf8")
    .matchAll(/^export (?:declare )?(?:function|const|let|var|class) (\w+)/gm)].map((m) => m[1]),
);

test("every runtime export is declared", () => {
  for (const name of Object.keys(pixelService)) {
    assert.ok(declared.has(name), `${name} is exported by src/index.mjs but missing from src/index.d.mts`);
  }
});

test("every declared value export exists at runtime", () => {
  for (const name of declared) {
    assert.ok(name in pixelService, `${name} is declared in src/index.d.mts but not exported by src/index.mjs`);
  }
});

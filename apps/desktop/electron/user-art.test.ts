import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findUserArt, listUserArt } from "./user-art.js";

test("user art resolves inbox-zero by extension in the data folder and nothing else", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-art-"));
  assert.equal(findUserArt(dir, "inbox-zero"), null, "nothing there yet");
  assert.deepEqual(listUserArt(dir), []);
  fs.writeFileSync(path.join(dir, "inbox-zero.png"), "png");
  assert.deepEqual(findUserArt(dir, "inbox-zero"), { file: path.join(dir, "inbox-zero.png"), type: "image/png" });
  fs.writeFileSync(path.join(dir, "inbox-zero.webp"), "webp");
  assert.equal(findUserArt(dir, "inbox-zero")?.type, "image/webp", "webp wins when both exist");
  assert.deepEqual(listUserArt(dir), ["inbox-zero"]);
  fs.writeFileSync(path.join(dir, "tokens.json"), "{}");
  assert.equal(findUserArt(dir, "tokens"), null, "only known names are served, never arbitrary files from the data folder");
  assert.equal(findUserArt(dir, "../inbox-zero"), null);
});

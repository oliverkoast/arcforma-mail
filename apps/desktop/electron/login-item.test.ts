import { test } from "node:test";
import assert from "node:assert/strict";
import { loginItemAllowed } from "./login-item.js";

test("the login item is only ever touched by a packed macOS app outside a smoke run", () => {
  assert.equal(loginItemAllowed({ isPackaged: true, platform: "darwin", smoke: undefined }), true);
  assert.equal(loginItemAllowed({ isPackaged: false, platform: "darwin", smoke: undefined }), false, "pnpm dev runs the bare Electron binary");
  assert.equal(loginItemAllowed({ isPackaged: true, platform: "darwin", smoke: "/tmp/arcmail-smoke" }), false, "smoke never registers itself");
  assert.equal(loginItemAllowed({ isPackaged: false, platform: "darwin", smoke: "/tmp/arcmail-smoke" }), false);
  assert.equal(loginItemAllowed({ isPackaged: true, platform: "linux", smoke: undefined }), false);
  assert.equal(loginItemAllowed({ isPackaged: true, platform: "darwin", smoke: "" }), true, "an empty variable is the same as unset");
});

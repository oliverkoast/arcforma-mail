import { test } from "node:test";
import assert from "node:assert/strict";
import { isTrustedSender, APP_ORIGIN } from "./ipc-sender.js";

test("the app's own top frame is trusted", () => {
  assert.equal(isTrustedSender({ url: `${APP_ORIGIN}/index.html` }), true);
  assert.equal(isTrustedSender({ url: `${APP_ORIGIN}/index.html#/settings` }), true);
});

test("a subframe is never trusted, however it was served", () => {
  // Message bodies render in sandboxed iframes. One of those speaking to the main process is the
  // attack this guard exists to stop, so being served from our own origin does not save it.
  assert.equal(isTrustedSender({ url: `${APP_ORIGIN}/index.html`, parent: {} }), false);
});

test("any other origin is refused", () => {
  for (const url of [
    "https://evil.example/x",
    "http://localhost:5173/",
    "file:///Users/someone/index.html",
    "app://other/index.html",
    "data:text/html,<script>",
    "javascript:void 0",
  ]) {
    assert.equal(isTrustedSender({ url }), false, url);
  }
});

test("the dev server is trusted only when it is passed in", () => {
  assert.equal(isTrustedSender({ url: "http://localhost:5173/index.html" }), false);
  assert.equal(isTrustedSender({ url: "http://localhost:5173/index.html" }, "http://localhost:5173"), true);
  assert.equal(isTrustedSender({ url: "http://localhost:5174/index.html" }, "http://localhost:5173"), false);
});

test("a missing or unparseable frame is refused, never treated as absent", () => {
  assert.equal(isTrustedSender(null), false);
  assert.equal(isTrustedSender(undefined), false);
  assert.equal(isTrustedSender({ url: "" }), false);
  assert.equal(isTrustedSender({ url: "not a url" }), false);
});

test("the dev server is accepted when it is configured as a whole URL, not a bare origin", () => {
  // VITE_DEV_SERVER_URL carries a path and a trailing slash. Comparing it to an origin string
  // refused every IPC call under pnpm dev, and the smoke run could not catch it because smoke is
  // served over app:// like the packed app.
  const frame = { url: "http://localhost:5173/index.html" };
  assert.equal(isTrustedSender(frame, "http://localhost:5173/"), true);
  assert.equal(isTrustedSender(frame, "http://localhost:5173"), true);
  assert.equal(isTrustedSender(frame, "http://localhost:4173/"), false, "a different port is a different origin");
  assert.equal(isTrustedSender(frame, "not a url"), false);
});

test("a dev origin never rescues a subframe", () => {
  assert.equal(isTrustedSender({ url: "http://localhost:5173/", parent: {} }, "http://localhost:5173/"), false);
});

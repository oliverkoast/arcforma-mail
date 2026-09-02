import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_ORIGIN, isAllowedNavigation, isExternalLink } from "./navigation.js";

test("only the app origin may navigate: app://mail passes, every other scheme and host is denied", () => {
  assert.equal(isAllowedNavigation("app://mail/index.html"), true);
  assert.equal(isAllowedNavigation("app://mail/"), true);
  assert.equal(isAllowedNavigation(`${APP_ORIGIN}/assets/index.js?x=1#frag`), true);
  for (const url of [
    "https://accounts.google.com/",
    "http://127.0.0.1:5173/",
    "http://evil.example/app://mail",
    "file:///Users/oliverkorzen/.ssh/id_rsa",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "about:blank",
    "app://other/index.html",
    "app://mail.evil.example/",
    "blob:app://mail/uuid",
    "",
    "not a url",
  ]) {
    assert.equal(isAllowedNavigation(url), false, url);
  }
});

test("in dev the Vite origin is also allowed, and only that origin", () => {
  const policy = { devUrl: "http://localhost:5173/" };
  assert.equal(isAllowedNavigation("http://localhost:5173/", policy), true);
  assert.equal(isAllowedNavigation("http://localhost:5173/src/main.tsx", policy), true);
  assert.equal(isAllowedNavigation("app://mail/index.html", policy), true);
  assert.equal(isAllowedNavigation("http://localhost:5174/", policy), false);
  assert.equal(isAllowedNavigation("https://localhost:5173/", policy), false);
  assert.equal(isAllowedNavigation("http://localhost.evil.example:5173/", policy), false);
  assert.equal(isAllowedNavigation("http://localhost:5173/", { devUrl: undefined }), false);
});

test("external links handed to the browser are http or https and nothing else", () => {
  assert.equal(isExternalLink("https://arcforma.ai/"), true);
  assert.equal(isExternalLink("HTTP://example.com"), true);
  assert.equal(isExternalLink("mailto:you@example.com"), false);
  assert.equal(isExternalLink("file:///etc/passwd"), false);
  assert.equal(isExternalLink("javascript:void(0)"), false);
  assert.equal(isExternalLink("app://mail/"), false);
});

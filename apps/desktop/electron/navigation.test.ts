import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_ORIGIN, PDF_VIEWER_ORIGIN, isAllowedNavigation, isExternalLink, isPreviewNavigation } from "./navigation.js";

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

test("an attachment preview window is pinned to its one URL and may go nowhere else", () => {
  // Two WebContents, one pinned URL each: the page for the header, and the
  // attachment route for the PDF viewer parked under it.
  const page = "app://mail/preview.html?account=arcforma&message=m1&key=1";
  const bytes = "app://mail/attachment/arcforma/m1/1";
  const pinned = [page];
  assert.equal(isPreviewNavigation(page, pinned), true);
  assert.equal(isPreviewNavigation(bytes, pinned), false, "the header page may not become the file it describes");
  assert.equal(isPreviewNavigation(bytes, [bytes]), true, "the PDF view is pinned to its own one file");
  assert.equal(isPreviewNavigation(`${bytes}#page=2`, [bytes]), true, "the PDF viewer moves the fragment as you scroll");
  assert.equal(isPreviewNavigation("app://mail/attachment/arcforma/m1/2", [bytes]), false, "and never to a second one");
  assert.equal(isPreviewNavigation("about:blank", pinned), true, "the window starts blank before its page loads");
  // Chromium renders a PDF through its own viewer frame; that one internal origin is the only extra.
  assert.equal(isPreviewNavigation(`${PDF_VIEWER_ORIGIN}/index.html`, pinned), true);
  assert.equal(isPreviewNavigation("chrome-extension://someotherextensionidgoeshere/x.html", pinned), false);
  for (const url of [
    "app://mail/index.html",
    "app://mail/preview.html?account=other&message=m9&key=1",
    "app://mail/attachment/arcforma/m1/2",
    "app://mail/attachment/arcforma/m9/1",
    "https://arcforma.ai/",
    "http://127.0.0.1:5173/",
    "file:///Users/oliverkorzen/.ssh/id_rsa",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "blob:app://mail/uuid",
    "",
  ]) {
    assert.equal(isPreviewNavigation(url, pinned), false, url);
  }
  assert.equal(isPreviewNavigation("app://mail/index.html", []), false, "a window with no pinned URL goes nowhere at all");
  assert.equal(isPreviewNavigation(page, page), true, "one URL may be given on its own");
});

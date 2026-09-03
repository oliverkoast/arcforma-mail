// The preview type router. What matters most here is what it refuses: an
// attachment that is not an image, a PDF, or plain text must land on "none" and
// be served as octet-stream, so nothing a sender chose can be rendered as
// markup or handed to anything that would run it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { baseMime, previewKind, previewWindowSize, serveType } from "./kind.js";

test("images, PDFs, and text are recognised by their declared type", () => {
  for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp", "IMAGE/PNG", "image/png; name=x"]) {
    assert.equal(previewKind(mime, "x"), "image", mime);
  }
  assert.equal(previewKind("application/pdf", "invoice.pdf"), "pdf");
  for (const mime of ["text/plain", "text/markdown", "text/csv", "application/json", "text/plain; charset=UTF-8"]) {
    assert.equal(previewKind(mime, "x"), "text", mime);
  }
  assert.equal(baseMime("text/plain; charset=UTF-8"), "text/plain");
  assert.equal(baseMime(null), "");
});

test("anything else is not previewed here, whatever it is called", () => {
  const refused = [
    ["text/html", "invoice.html"],
    ["text/html", "invoice.png"],
    ["application/xhtml+xml", "page.xhtml"],
    ["image/svg+xml", "logo.svg"],
    ["application/javascript", "script.js"],
    ["application/zip", "archive.zip"],
    ["application/x-apple-diskimage", "installer.dmg"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "contract.docx"],
    ["application/x-sh", "run.sh"],
    ["application/x-mach-binary", "tool"],
    ["video/mp4", "clip.mp4"],
  ] as const;
  for (const [mime, name] of refused) {
    assert.equal(previewKind(mime, name), "none", `${mime} ${name} was previewable`);
    assert.equal(serveType(mime, name), "application/octet-stream", `${mime} would have been served as itself`);
  }
  // A declared type is never overruled by the extension: this is what stops a
  // sender calling an HTML file "photo.png" to get it rendered as a document.
  assert.equal(previewKind("text/html", "photo.png"), "none");
  assert.equal(previewKind("image/svg+xml", "logo.png"), "none", "SVG is markup that can carry script, so it is not an image here");
});

test("the extension is only consulted when the sender declared nothing useful", () => {
  assert.equal(previewKind("", "invoice.pdf"), "pdf");
  assert.equal(previewKind(null, "photo.JPG"), "image");
  assert.equal(previewKind("application/octet-stream", "notes.md"), "text");
  assert.equal(previewKind("application/octet-stream", "data.csv"), "text");
  assert.equal(previewKind("application/octet-stream", "thing.exe"), "none");
  assert.equal(previewKind("application/octet-stream", "nameless"), "none");
  assert.equal(previewKind(undefined, ""), "none");
});

test("only images and PDFs are served as themselves; the rest are opaque bytes", () => {
  assert.equal(serveType("image/png", "a.png"), "image/png");
  assert.equal(serveType("", "a.jpeg"), "image/jpeg");
  assert.equal(serveType("", "a.gif"), "image/gif");
  assert.equal(serveType("", "a.webp"), "image/webp");
  assert.equal(serveType("", "a.png"), "image/png");
  assert.equal(serveType("application/pdf", "a.pdf"), "application/pdf");
  // Text is read into the page by the main process, so it is never served as a document at all.
  assert.equal(serveType("text/plain", "a.txt"), "application/octet-stream");
});

test("a preview window opens at a size that suits what it holds", () => {
  assert.ok(previewWindowSize("pdf").height > previewWindowSize("none").height);
  for (const kind of ["image", "pdf", "text", "none"] as const) {
    const size = previewWindowSize(kind);
    assert.ok(size.width >= 360 && size.height >= 240, `${kind} opens too small to use`);
  }
});

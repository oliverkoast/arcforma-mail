// The filename sanitiser and the path confinement, driven with the names a
// hostile sender would actually pick. Nothing here touches the filesystem: the
// point is that no name off the network can ever become a path, so the check is
// on the strings themselves.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { MAX_FILENAME, attachmentsRoot, extensionOf, isInRoot, messageCacheDir, resolveInRoot, safeFilename, safeSegment, uniqueFilename } from "./paths.js";

const ROOT = "/Users/someone/Library/Application Support/Arcforma Mail/attachments";

test("the sanitiser refuses traversal, absolute paths, and separators of both kinds", () => {
  const hostile = [
    "../../../../etc/passwd",
    "..\\..\\Windows\\System32\\drivers\\etc\\hosts",
    "/etc/passwd",
    "/Users/someone/Library/LaunchAgents/evil.plist",
    "C:\\Users\\someone\\evil.exe",
    "foo/../../bar.pdf",
    "sub/dir/report.pdf",
    "....//....//secret.txt",
  ];
  for (const name of hostile) {
    const safe = safeFilename(name);
    assert.equal(safe.includes("/"), false, `${name} kept a forward slash: ${safe}`);
    assert.equal(safe.includes("\\"), false, `${name} kept a backslash: ${safe}`);
    assert.equal(safe.startsWith("."), false, `${name} became a dotfile: ${safe}`);
    assert.equal(path.basename(safe), safe, `${name} is not a bare basename: ${safe}`);
    assert.equal(path.isAbsolute(safe), false, `${name} stayed absolute: ${safe}`);
    // The finished path stays inside the root, which is the property that matters.
    assert.equal(isInRoot(ROOT, path.join(ROOT, safe)), true, `${name} escaped the root: ${safe}`);
  }
  assert.equal(safeFilename("../../../../etc/passwd"), "etcpasswd");
  assert.equal(safeFilename("sub/dir/report.pdf"), "subdirreport.pdf");
});

test("control characters, nulls, and the bidi overrides that fake an extension are stripped", () => {
  assert.equal(safeFilename("in\u0000voice.pdf"), "invoice.pdf", "a NUL cannot truncate the name at the syscall");
  assert.equal(safeFilename("re\nport\t.pdf"), "report.pdf", "newlines and tabs are dropped outright");
  // U+202E flips what is after it, so "invoice\u202Egnp.exe" reads as "invoice.exe.png" on screen.
  const spoofed = safeFilename("invoice\u202Egnp.exe");
  assert.equal(spoofed.includes("\u202E"), false, "the right-to-left override is gone");
  assert.equal(spoofed, "invoicegnp.exe");
  for (const c of ["\u0007", "\u001b", "\u007f", "\u200b", "\ufeff"]) {
    assert.equal(safeFilename(`a${c}b.txt`), "ab.txt", `${JSON.stringify(c)} survived`);
  }
});

test("an empty, dotted, or unusable name falls back rather than becoming nothing", () => {
  for (const empty of ["", "   ", ".", "..", "...", "/", "//", "\\", "....", "/////", undefined, null, 42, {}]) {
    assert.equal(safeFilename(empty as string), "attachment", `${JSON.stringify(empty)} did not fall back`);
  }
  assert.equal(safeFilename(".hidden"), "hidden", "a leading dot is dropped, not the whole name");
  assert.equal(safeFilename("report."), "report", "a trailing dot is dropped: two names must not land on one file");
  assert.equal(safeFilename("report.pdf   "), "report.pdf");
  assert.equal(safeFilename("", "invoice.pdf"), "invoice.pdf", "a caller may name the fallback");
  assert.equal(safeFilename("", "../evil"), "evil", "and the fallback goes through the same door");
});

test("names that are legitimate survive intact, including non-Latin scripts", () => {
  for (const name of ["Invoice 2026-08.pdf", "Q3 numbers (final).xlsx", "notes_v2.md", "photo-1.jpeg", "契約書.pdf", "Отчёт.docx", "a+b&c@d.txt", "résumé.pdf"]) {
    assert.equal(safeFilename(name), name, `${name} was mangled`);
  }
});

test("a very long name is cut but keeps its extension", () => {
  const long = `${"a".repeat(400)}.pdf`;
  const safe = safeFilename(long);
  assert.ok(safe.length <= MAX_FILENAME, `${safe.length} characters is over the cap`);
  assert.ok(safe.endsWith(".pdf"), "a cut name must not become extensionless");
  assert.equal(extensionOf("archive.tar.gz"), ".gz");
  assert.equal(extensionOf("noextension"), "");
  assert.equal(extensionOf(".hidden"), "", "a leading dot is not an extension");
  assert.equal(extensionOf("name.averyverylongsuffix"), "", "a long trailing word is not read as an extension");
});

test("duplicates are suffixed before the extension, so the copy still opens as what it is", () => {
  const taken = new Set(["report.pdf", "report-1.pdf"]);
  assert.equal(uniqueFilename("report.pdf", (c) => taken.has(c)), "report-2.pdf");
  assert.equal(uniqueFilename("fresh.pdf", (c) => taken.has(c)), "fresh.pdf");
  assert.equal(uniqueFilename("noext", (c) => c === "noext"), "noext-1");
});

test("path confinement refuses anything that resolves outside the root, and the root itself", () => {
  const root = attachmentsRoot("/data");
  assert.equal(root, path.join("/data", "attachments"));
  assert.equal(resolveInRoot(root, path.join(root, "acct", "msg", "file.pdf")), path.join(root, "acct", "msg", "file.pdf"));
  for (const bad of [root, `${root}/..`, `${root}/../secrets.txt`, "/etc/passwd", "/data/tokens.json", `${root}/a/../../../b`, "/dataattachments/x", `${root}xyz/file.pdf`]) {
    assert.throws(() => resolveInRoot(root, bad), /outside the attachments folder/, `${bad} was allowed`);
    assert.equal(isInRoot(root, bad), false);
  }
  // A relative path is resolved against the root, so it cannot climb out either.
  assert.throws(() => resolveInRoot(root, "../../etc/passwd"), /outside the attachments folder/);
  assert.equal(resolveInRoot(root, "acct/msg/x.pdf"), path.join(root, "acct", "msg", "x.pdf"));
});

test("account and message ids become one path segment each, whatever they arrive as", () => {
  const root = attachmentsRoot("/data");
  assert.equal(messageCacheDir(root, "arcforma", "18f2c9"), path.join(root, "arcforma", "18f2c9"));
  assert.equal(messageCacheDir(root, "../../..", "../etc"), path.join(root, "account", "etc"), "an id that sanitises to nothing takes its fallback segment");
  assert.equal(safeSegment("a/b/c"), "abc");
  assert.equal(safeSegment(""), "unknown");
  assert.equal(safeSegment(".."), "unknown", "an id that is only dots is not a path step");
  assert.equal(isInRoot(root, messageCacheDir(root, "/etc/passwd", "\\..\\..")), true, "a hostile id still lands inside the root");
});

// The cache on real files in a temp folder: what it writes, where, with what
// permissions, what it hands back on a second open, and what it refuses.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore, recordAttachmentFile, upsertAccount, upsertThreadFromGmail, type Db, type GmailThreadInput } from "@arcforma/store";
import { nonClobberingPath, readCached, unlinkOrphans, writeCached } from "./cache.js";
import { attachmentsRoot, messageCacheDir } from "./paths.js";

function temp(): { db: Db; root: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-attach-"));
  const db = openStore(path.join(dir, "mail.db"));
  upsertAccount(db, { id: "arcforma", email: "you@example.com", consent: "internal" });
  const thread: GmailThreadInput = {
    id: "t1",
    historyId: "1",
    messages: [
      {
        id: "m1",
        threadId: "t1",
        labelIds: ["INBOX"],
        snippet: "",
        internalDate: "1000",
        historyId: "1",
        payload: { mimeType: "multipart/mixed", headers: [{ name: "From", value: "maya@arcforma.ai" }, { name: "Subject", value: "Invoice" }] },
      },
    ],
  };
  upsertThreadFromGmail(db, "arcforma", thread, { ownerAddresses: ["you@example.com"] });
  return { db, root: attachmentsRoot(dir), dir };
}

test("a write lands under the account and message folder, mode 0600, and the second open reads the file back", () => {
  const { db, root } = temp();
  assert.equal(readCached(db, root, "arcforma", "m1", "1"), null, "nothing is cached before the first fetch");
  const written = writeCached(db, root, { accountId: "arcforma", messageId: "m1", attachmentKey: "1", filename: "Invoice 2026-08.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4 fake") });
  assert.equal(written.filename, "Invoice 2026-08.pdf");
  assert.equal(written.path, path.join(messageCacheDir(root, "arcforma", "m1"), "Invoice 2026-08.pdf"));
  assert.equal(fs.readFileSync(written.path, "utf8"), "%PDF-1.4 fake");
  assert.equal(fs.statSync(written.path).mode & 0o777, 0o600, "the file is readable by its owner only");
  assert.equal(fs.readdirSync(path.dirname(written.path)).some((f) => f.endsWith(".part")), false, "the temp file is renamed away, never left behind");

  const again = readCached(db, root, "arcforma", "m1", "1")!;
  assert.deepEqual(again, { path: written.path, filename: "Invoice 2026-08.pdf", mimeType: "application/pdf", bytes: 13 });
});

test("a hostile filename is rebuilt before it touches the disk, and stays under the root", () => {
  const { db, root } = temp();
  const written = writeCached(db, root, { accountId: "arcforma", messageId: "m1", attachmentKey: "1", filename: "../../../../tmp/pwned.sh", mimeType: "application/x-sh", bytes: Buffer.from("rm -rf /") });
  assert.equal(written.filename, "tmppwned.sh");
  assert.ok(written.path.startsWith(`${root}${path.sep}`), `${written.path} escaped the root`);
  assert.equal(fs.existsSync("/tmp/pwned.sh"), false);
});

test("two parts wanting the same name get separate files; refetching one part replaces its own file", () => {
  const { db, root } = temp();
  const a = writeCached(db, root, { accountId: "arcforma", messageId: "m1", attachmentKey: "1", filename: "scan.pdf", mimeType: "application/pdf", bytes: Buffer.from("one") });
  const b = writeCached(db, root, { accountId: "arcforma", messageId: "m1", attachmentKey: "2", filename: "scan.pdf", mimeType: "application/pdf", bytes: Buffer.from("two") });
  assert.equal(path.basename(a.path), "scan.pdf");
  assert.equal(path.basename(b.path), "scan-1.pdf");
  const again = writeCached(db, root, { accountId: "arcforma", messageId: "m1", attachmentKey: "1", filename: "scan.pdf", mimeType: "application/pdf", bytes: Buffer.from("one again") });
  assert.equal(again.path, a.path, "a part replaces its own file rather than growing a suffix each time");
  assert.deepEqual([...fs.readdirSync(path.dirname(a.path))].sort(), ["scan-1.pdf", "scan.pdf"], "two files, not three");
});

test("a cache row whose file has gone is a miss, and the row is dropped so the next open fetches", () => {
  const { db, root } = temp();
  const written = writeCached(db, root, { accountId: "arcforma", messageId: "m1", attachmentKey: "1", filename: "gone.txt", mimeType: "text/plain", bytes: Buffer.from("x") });
  fs.rmSync(written.path);
  assert.equal(readCached(db, root, "arcforma", "m1", "1"), null);
  assert.equal(readCached(db, root, "arcforma", "m1", "1"), null, "and it stays a miss rather than throwing");
});

test("a cache row pointing outside the root is refused, not read", () => {
  const { db, root, dir } = temp();
  const outside = path.join(dir, "tokens.json");
  fs.writeFileSync(outside, "{}");
  // The only way to get here is a tampered store; the row is treated as a miss and forgotten.
  recordAttachmentFile(db, { accountId: "arcforma", messageId: "m1", attachmentKey: "1", filename: "tokens.json", mimeType: "application/json", bytes: 2, path: outside });
  assert.equal(readCached(db, root, "arcforma", "m1", "1"), null, "the escaping row did not become a readable file");
  assert.equal(fs.existsSync(outside), true, "and nothing outside the root was touched");
});

test("orphan paths are unlinked only inside the root, and the empty folders go with them", () => {
  const { db, root, dir } = temp();
  const written = writeCached(db, root, { accountId: "arcforma", messageId: "m1", attachmentKey: "1", filename: "bye.txt", mimeType: "text/plain", bytes: Buffer.from("x") });
  const outside = path.join(dir, "keep-me.json");
  fs.writeFileSync(outside, "{}");
  const result = unlinkOrphans(root, [written.path, outside, "/etc/passwd", `${root}/../escape.txt`]);
  assert.equal(result.removed, 1);
  assert.equal(result.refused, 3, "every path that resolved outside the root was left alone");
  assert.equal(fs.existsSync(written.path), false);
  assert.equal(fs.existsSync(outside), true);
  assert.equal(fs.existsSync(path.join(root, "arcforma", "m1")), false, "the message folder goes once it is empty");
  assert.equal(fs.existsSync(root), true, "the root itself is never removed");
  assert.deepEqual(unlinkOrphans(root, []), { removed: 0, refused: 0 });
});

test("a copy out of the cache never clobbers a file already in the destination folder", () => {
  const { dir } = temp();
  const downloads = path.join(dir, "Downloads");
  fs.mkdirSync(downloads);
  assert.equal(nonClobberingPath(downloads, "report.pdf"), path.join(downloads, "report.pdf"));
  fs.writeFileSync(path.join(downloads, "report.pdf"), "old");
  assert.equal(nonClobberingPath(downloads, "report.pdf"), path.join(downloads, "report-1.pdf"));
  fs.writeFileSync(path.join(downloads, "report-1.pdf"), "older");
  assert.equal(nonClobberingPath(downloads, "report.pdf"), path.join(downloads, "report-2.pdf"));
  // The name is sanitised on the way out too: a copy leaving our folder is exactly where a traversal would hurt.
  assert.equal(nonClobberingPath(downloads, "../../evil.sh"), path.join(downloads, "evil.sh"));
});

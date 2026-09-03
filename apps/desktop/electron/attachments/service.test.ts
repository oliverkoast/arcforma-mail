// Resolving an attachment key against the stored message, fetching what is not
// cached, and reaping the files of a message that has gone.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GmailClient, listAttachments, type GmailPart } from "@arcforma/gmail";
import { deleteMessage, openStore, saveBody, upsertAccount, upsertThreadFromGmail, type Db, type GmailThreadInput } from "@arcforma/store";
import { readCached } from "./cache.js";
import { attachmentsRoot } from "./paths.js";
import { AttachmentReaper } from "./reaper.js";
import { PROGRESS_THRESHOLD, attachmentKey, ensureCached, fetchErrorText, findPart, listParts, type AttachmentProgress } from "./service.js";

const DECK = Buffer.from("%PDF-1.4 the deck");
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The payload of a message with a big PDF part (an id, no data) and a small inline note (data, no id). */
function payload(): GmailPart {
  return {
    mimeType: "multipart/mixed",
    headers: [{ name: "From", value: "maya@arcforma.ai" }, { name: "Subject", value: "Deck" }],
    parts: [
      { partId: "0", mimeType: "text/html", body: { data: b64url(Buffer.from("<p>See attached.</p>")) } },
      { partId: "1", mimeType: "application/pdf", filename: "deck.pdf", body: { attachmentId: "ANGjdJ_deck", size: DECK.length } },
      { partId: "2", mimeType: "text/plain", filename: "note.txt", body: { size: 5, data: b64url(Buffer.from("hello")) } },
    ],
  };
}

function temp(): { db: Db; root: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-attach-svc-"));
  const db = openStore(path.join(dir, "mail.db"));
  upsertAccount(db, { id: "arcforma", email: "you@example.com", consent: "internal" });
  const thread: GmailThreadInput = {
    id: "t1",
    historyId: "1",
    messages: [{ id: "m1", threadId: "t1", labelIds: ["INBOX"], snippet: "", internalDate: "1000", historyId: "1", payload: payload() }],
  };
  upsertThreadFromGmail(db, "arcforma", thread, { ownerAddresses: ["you@example.com"] });
  saveBody(db, "arcforma", "m1", { html: "<p>See attached.</p>", text: null, attachments: listAttachments(payload()) });
  return { db, root: attachmentsRoot(dir), dir };
}

/** A client whose every call answers with the deck, and that records how many times it was asked. */
function client(body: unknown, status = 200) {
  const calls: string[] = [];
  const c = new GmailClient({
    accessToken: async () => "t",
    transport: async (url) => {
      calls.push(url);
      return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
    },
  });
  return { c, calls };
}

test("an attachment key names a part of the stored message, and nothing else does", () => {
  const { db } = temp();
  const parts = listParts(db, "arcforma", "m1");
  assert.deepEqual(parts.map((p, i) => attachmentKey(p, i)), ["1", "2"], "the Gmail part id is the key");
  assert.equal(findPart(db, "arcforma", "m1", "1")!.part.filename, "deck.pdf");
  assert.equal(findPart(db, "arcforma", "m1", "1")!.kind, "pdf");
  assert.equal(findPart(db, "arcforma", "m1", "2")!.kind, "text");
  for (const bogus of ["0", "99", "../../etc/passwd", "", "deck.pdf"]) {
    assert.equal(findPart(db, "arcforma", "m1", bogus), null, `${bogus} resolved to a part`);
  }
  assert.deepEqual(listParts(db, "arcforma", "nope"), [], "a message with no stored body has no parts");
});

test("the first open fetches and caches; the second reads the file and never calls Gmail", async () => {
  const { db, root } = temp();
  const { c, calls } = client({ size: DECK.length, data: b64url(DECK) });
  const found = findPart(db, "arcforma", "m1", "1")!;
  const first = await ensureCached({ db, root, client: c }, "arcforma", "m1", found);
  assert.equal(first.fetched, true);
  assert.equal(first.file.filename, "deck.pdf");
  assert.equal(fs.readFileSync(first.file.path).equals(DECK), true);
  assert.equal(calls.length, 1);

  const second = await ensureCached({ db, root, client: c }, "arcforma", "m1", found);
  assert.equal(second.fetched, false, "the cache answered");
  assert.equal(second.file.path, first.file.path);
  assert.equal(calls.length, 1, "no second call went out");
  assert.equal(readCached(db, root, "arcforma", "m1", "1")!.bytes, DECK.length);
});

test("a part that carried its own bytes needs no account at all", async () => {
  const { db, root } = temp();
  const found = findPart(db, "arcforma", "m1", "2")!;
  const got = await ensureCached({ db, root, client: null }, "arcforma", "m1", found);
  assert.equal(got.fetched, true);
  assert.equal(fs.readFileSync(got.file.path, "utf8"), "hello");
});

test("a part that needs Gmail while the account is signed out says so", async () => {
  const { db, root } = temp();
  const found = findPart(db, "arcforma", "m1", "1")!;
  await assert.rejects(() => ensureCached({ db, root, client: null }, "arcforma", "m1", found), /Not signed in/);
  assert.equal(readCached(db, root, "arcforma", "m1", "1"), null, "and nothing half written is left in the cache");
});

test("a failed fetch leaves no file behind and comes back with a reason a toast can show", async () => {
  const { db, root } = temp();
  const { c } = client({ size: 0 });
  const found = findPart(db, "arcforma", "m1", "1")!;
  await assert.rejects(() => ensureCached({ db, root, client: c }, "arcforma", "m1", found));
  assert.equal(readCached(db, root, "arcforma", "m1", "1"), null);
  assert.equal(fs.existsSync(path.join(root, "arcforma", "m1")), false, "no folder, no part file, nothing");
  assert.equal(fetchErrorText({ code: "missing" }), "Gmail no longer has this attachment.");
  assert.equal(fetchErrorText({ code: "size_mismatch" }), "The attachment arrived the wrong size, so it was not saved.");
  assert.equal(fetchErrorText({ code: "no_source" }), "This attachment has no bytes to fetch.");
  assert.equal(fetchErrorText(new Error("network is down")), "network is down");
  assert.equal(fetchErrorText(null), "The attachment could not be fetched.");
});

test("anything over a megabyte reports that it is being fetched; anything under it does not", async () => {
  const { db, root, dir } = temp();
  const big = Buffer.alloc(PROGRESS_THRESHOLD, 0x41);
  saveBody(db, "arcforma", "m1", {
    html: null,
    text: null,
    attachments: [{ partId: "1", filename: "big.pdf", mimeType: "application/pdf", size: big.length, attachmentId: "A", contentId: null, inline: false }],
  });
  const seen: AttachmentProgress[] = [];
  const { c } = client({ size: big.length, data: b64url(big) });
  const found = findPart(db, "arcforma", "m1", "1")!;
  await ensureCached({ db, root, client: c, onProgress: (p) => seen.push(p) }, "arcforma", "m1", found);
  assert.deepEqual(seen.map((p) => p.phase), ["fetching", "done"]);
  assert.equal(seen[0]!.bytes, big.length);

  const small = temp();
  const smallSeen: AttachmentProgress[] = [];
  const { c: c2 } = client({ size: DECK.length, data: b64url(DECK) });
  await ensureCached({ db: small.db, root: small.root, client: c2, onProgress: (p) => smallSeen.push(p) }, "arcforma", "m1", findPart(small.db, "arcforma", "m1", "1")!);
  assert.deepEqual(smallSeen, [], "a small attachment is fetched before a bar would paint");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("deleting the message removes its cached files from disk on the next sweep", async () => {
  const { db, root } = temp();
  const { c } = client({ size: DECK.length, data: b64url(DECK) });
  const pdf = await ensureCached({ db, root, client: c }, "arcforma", "m1", findPart(db, "arcforma", "m1", "1")!);
  const note = await ensureCached({ db, root, client: null }, "arcforma", "m1", findPart(db, "arcforma", "m1", "2")!);
  assert.equal(fs.existsSync(pdf.file.path), true);
  assert.equal(fs.existsSync(note.file.path), true);

  deleteMessage(db, "arcforma", "m1");
  const reaper = new AttachmentReaper(db, root);
  const result = reaper.sweep();
  assert.equal(result.removed, 2);
  assert.equal(result.refused, 0);
  assert.equal(fs.existsSync(pdf.file.path), false);
  assert.equal(fs.existsSync(note.file.path), false);
  assert.equal(fs.existsSync(path.join(root, "arcforma")), false, "the folders go with the last file in them");
  assert.deepEqual(reaper.sweep(), { removed: 0, refused: 0 }, "a second sweep has nothing left to do");
});

test("the reaper refuses a queued path that resolves outside the attachments folder", () => {
  const { db, root, dir } = temp();
  const outside = path.join(dir, "tokens.json");
  fs.writeFileSync(outside, "{}");
  db.prepare("INSERT INTO orphan_attachments (path, orphaned_at) VALUES (?, ?)").run(outside, 1000);
  db.prepare("INSERT INTO orphan_attachments (path, orphaned_at) VALUES (?, ?)").run("/etc/passwd", 1000);
  const result = new AttachmentReaper(db, root).sweep();
  assert.deepEqual(result, { removed: 0, refused: 2 });
  assert.equal(fs.existsSync(outside), true, "a tampered row cannot delete a file this feature does not own");
});

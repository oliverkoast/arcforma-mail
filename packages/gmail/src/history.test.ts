import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore, upsertAccount, upsertThreadFromGmail, applyHistory, getThread, archive, markOutboxDone, listOutbox } from "@arcforma/store";
import { GmailClient } from "./client.js";
import { HistoryExpiredError } from "./errors.js";
import { normalizeHistory, pullHistory, type HistoryPage } from "./history.js";
import { fakeTransport, fixtureJson, token } from "../test/helpers.js";

interface Fixture {
  seed: Parameters<typeof upsertThreadFromGmail>[2];
  pages: HistoryPage[];
  expired: unknown;
}

const fx = fixtureJson<Fixture>("history-pages.json");

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-gmail-"));
  const db = openStore(path.join(dir, "mail.db"));
  upsertAccount(db, { id: "arcforma", email: "you@example.com" });
  upsertThreadFromGmail(db, "arcforma", fx.seed);
  return db;
}

test("normalizeHistory flattens records in Gmail order", () => {
  const changes = normalizeHistory(fx.pages[0]!);
  assert.deepEqual(changes.map((c) => [c.type, c.messageId, c.historyId]), [
    ["labelRemoved", "m1", "501"],
    ["labelAdded", "m1", "505"],
    ["messageAdded", "m2", "510"],
  ]);
  assert.deepEqual(changes[2]!.labelIds, ["INBOX", "UNREAD"]);
});

test("pullHistory pages from the watermark and the replay updates the store", async () => {
  const { transport, calls } = fakeTransport([
    { status: 200, body: fx.pages[0] },
    { status: 200, body: fx.pages[1] },
  ]);
  const client = new GmailClient({ accessToken: token, transport, sleep: async () => {} });
  const { changes, historyId } = await pullHistory({ client, startHistoryId: "500" });
  assert.equal(historyId, "530");
  assert.match(calls[0]!.url, /history\?startHistoryId=500&historyTypes=messageAdded&historyTypes=messageDeleted&historyTypes=labelAdded&historyTypes=labelRemoved/);
  assert.match(calls[1]!.url, /pageToken=page2/);

  const db = tempStore();
  // Replay page 1: read, star, and a new message on an unknown thread.
  const r1 = applyHistory(db, "arcforma", changes.slice(0, 3));
  const t1 = getThread(db, "arcforma", "t1")!;
  assert.equal(t1.unread, 0);
  assert.equal(t1.starred, 1);
  assert.deepEqual(r1.threadsToFetch, ["t2"]);
  // Replay page 2: label flip out and back in, then the delete removes the thread.
  const r2 = applyHistory(db, "arcforma", changes.slice(3, 5));
  assert.equal(getThread(db, "arcforma", "t1")!.in_inbox, 1);
  assert.equal(r2.lastHistoryId, "525");
  applyHistory(db, "arcforma", changes.slice(5));
  assert.equal(getThread(db, "arcforma", "t1"), null);
});

test("a local archive masks the incoming label flip until the outbox acks", async () => {
  const db = tempStore();
  const outboxId = archive(db, "arcforma", "t1");
  const flip = normalizeHistory(fx.pages[1]!).slice(0, 2);
  const masked = applyHistory(db, "arcforma", flip);
  assert.equal(masked.masked, 2);
  assert.equal(getThread(db, "arcforma", "t1")!.in_inbox, 0);
  assert.equal(listOutbox(db, "arcforma", "pending").length, 1);
  markOutboxDone(db, outboxId);
  const applied = applyHistory(db, "arcforma", flip);
  assert.equal(applied.masked, 0);
  assert.equal(getThread(db, "arcforma", "t1")!.in_inbox, 1);
});

test("an expired watermark surfaces as HistoryExpiredError", async () => {
  const { transport } = fakeTransport([{ status: 404, body: fx.expired }]);
  const client = new GmailClient({ accessToken: token, transport, sleep: async () => {} });
  await assert.rejects(pullHistory({ client, startHistoryId: "1" }), HistoryExpiredError);
});

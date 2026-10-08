import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listThreadMessages, openStore, threadsNeedingClassification, upsertAccount, upsertClassification, upsertThreadFromGmail } from "../index.js";

const NOW = Date.now();

function msg(id: string, from: string, date: number, labels: string[]) {
  return {
    id,
    threadId: "t1",
    labelIds: labels,
    snippet: "",
    internalDate: String(date),
    historyId: "1",
    payload: { mimeType: "text/plain", headers: [{ name: "From", value: from }, { name: "To", value: "you@example.com" }, { name: "Subject", value: "Kickoff" }, { name: "Message-ID", value: `<${id}@x>` }] },
  };
}

function seed(messages: ReturnType<typeof msg>[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-classify-"));
  const db = openStore(path.join(dir, "mail.db"));
  upsertAccount(db, { id: "arcforma", email: "you@example.com" });
  upsertThreadFromGmail(db, "arcforma", { id: "t1", historyId: "1", messages }, { ownerAddresses: ["you@example.com"] });
  return db;
}

/** What the classifier writes: the last message listThreadMessages returns, which leaves drafts out. */
function classifyLikeThePipeline(db: ReturnType<typeof seed>) {
  const last = listThreadMessages(db, "arcforma", "t1").at(-1);
  upsertClassification(db, { accountId: "arcforma", threadId: "t1", split: "important", type: null, categoryId: null, confidence: 1, source: "rule", lastMessageId: last?.id ?? null, attention: 50, band: "important", reason: "" });
}

test("a thread ending in the owner's unsent draft is classified once, not every pass", () => {
  const db = seed([msg("m1", "Dana <dana@northwind.example>", NOW - 3_600_000, ["INBOX"]), msg("d1", "you@example.com", NOW - 60_000, ["DRAFT"])]);
  assert.equal(threadsNeedingClassification(db).length, 1, "unclassified, so it needs a verdict");
  classifyLikeThePipeline(db);
  assert.equal(threadsNeedingClassification(db).length, 0, "the draft must not make the verdict look out of date");
});

test("a new real message still makes the verdict out of date", () => {
  const db = seed([msg("m1", "Dana <dana@northwind.example>", NOW - 3_600_000, ["INBOX"]), msg("d1", "you@example.com", NOW - 60_000, ["DRAFT"])]);
  classifyLikeThePipeline(db);
  upsertThreadFromGmail(
    db,
    "arcforma",
    { id: "t1", historyId: "2", messages: [msg("m1", "Dana <dana@northwind.example>", NOW - 3_600_000, ["INBOX"]), msg("d1", "you@example.com", NOW - 60_000, ["DRAFT"]), msg("m2", "Dana <dana@northwind.example>", NOW - 1000, ["INBOX"])] },
    { ownerAddresses: ["you@example.com"] }
  );
  assert.equal(threadsNeedingClassification(db).length, 1);
});

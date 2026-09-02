import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getUnsubscribeState, listThreads, openStore, search, setUnsubscribeState, unsubscribeSource, upsertAccount, upsertThreadFromGmail } from "../index.js";

const T0 = 1_800_000_000_000;

function msg(id: string, threadId: string, from: string, date: number, headers: Record<string, string> = {}, labels = ["INBOX"]) {
  return {
    id,
    threadId,
    labelIds: labels,
    snippet: "",
    internalDate: String(date),
    historyId: "1",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: from },
        { name: "To", value: "you@example.com" },
        { name: "Subject", value: "Weekly issue" },
        { name: "Message-ID", value: `<${id}@x>` },
        ...Object.entries(headers).map(([name, value]) => ({ name, value })),
      ],
    },
  };
}

function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-unsub-"));
  const db = openStore(path.join(dir, "mail.db"));
  upsertAccount(db, { id: "arcforma", email: "you@example.com" });
  const owners = { ownerAddresses: ["you@example.com"] };
  upsertThreadFromGmail(
    db,
    "arcforma",
    {
      id: "lenny",
      historyId: "1",
      messages: [
        msg("l1", "lenny", "Lenny's Newsletter <lenny@substack.example>", T0 - 2000, { "List-Unsubscribe": "<mailto:unsub@substack.example?subject=unsubscribe>", "List-Id": "<lenny.substack.example>" }),
        msg("l2", "lenny", "Lenny's Newsletter <lenny@substack.example>", T0 - 1000, { "List-Unsubscribe": "<https://substack.example/u/abc>, <mailto:unsub@substack.example>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }),
        msg("l3", "lenny", "Oliver Korzen <you@example.com>", T0, {}, ["SENT"]),
      ],
    },
    owners
  );
  upsertThreadFromGmail(db, "arcforma", { id: "dana", historyId: "1", messages: [msg("d1", "dana", "Dana Reyes <dana@northwind.example>", T0 - 500)] }, owners);
  return db;
}

test("unsubscribeSource finds the newest inbound message with a List-Unsubscribe header and keeps the Post header", () => {
  const db = seed();
  const src = unsubscribeSource(db, "arcforma", "lenny");
  assert.ok(src);
  assert.equal(src!.messageId, "l2", "the newer inbound message wins; Oliver's own reply is skipped");
  assert.equal(src!.fromName, "Lenny's Newsletter");
  assert.equal(src!.fromEmail, "lenny@substack.example");
  assert.match(src!.listUnsubscribe, /^<https:/);
  assert.equal(src!.listUnsubscribePost, "List-Unsubscribe=One-Click");
  assert.equal(src!.listId, null, "the newest message carries no List-Id");
  assert.equal(unsubscribeSource(db, "arcforma", "dana"), null);
});

test("the list carries can_unsubscribe and the stored state; search rows match", () => {
  const db = seed();
  const rows = listThreads(db, { view: "all" }).rows;
  const lenny = rows.find((r) => r.id === "lenny")!;
  const dana = rows.find((r) => r.id === "dana")!;
  assert.equal(lenny.can_unsubscribe, 1);
  assert.equal(dana.can_unsubscribe, 0);
  assert.equal(lenny.unsubscribe_state, null);
  assert.equal(getUnsubscribeState(db, "arcforma", "lenny"), null);
  setUnsubscribeState(db, "arcforma", "lenny", { state: "sent", method: "one-click", target: "https://substack.example/u/abc" }, T0);
  const row = getUnsubscribeState(db, "arcforma", "lenny")!;
  assert.equal(row.state, "sent");
  assert.equal(row.method, "one-click");
  assert.equal(row.updated_at, T0);
  assert.equal(listThreads(db, { view: "all" }).rows.find((r) => r.id === "lenny")!.unsubscribe_state, "sent");
  setUnsubscribeState(db, "arcforma", "lenny", { state: "failed", method: "one-click", error: "HTTP 500" }, T0 + 1);
  assert.equal(getUnsubscribeState(db, "arcforma", "lenny")!.error, "HTTP 500", "a second write replaces the first");
  const hit = search(db, "weekly").find((h) => h.row.id === "lenny")!;
  assert.equal(hit.row.unsubscribe_state, "failed");
  assert.equal(hit.row.can_unsubscribe, 1);
});

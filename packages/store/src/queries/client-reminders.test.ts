import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS, clientReminderApplies, createCategory, getSettings, openStore, scopedCategoryIds, setSetting, threadInCategories, twoWayInCategories, upsertAccount, upsertClassification, upsertThreadFromGmail } from "../index.js";

const T0 = 1_800_000_000_000;

function msg(id: string, threadId: string, from: string, to: string, date: number, labels: string[]) {
  return {
    id,
    threadId,
    labelIds: labels,
    snippet: "",
    internalDate: String(date),
    historyId: "1",
    payload: { mimeType: "text/plain", headers: [{ name: "From", value: from }, { name: "To", value: to }, { name: "Subject", value: threadId }, { name: "Message-ID", value: `<${id}@x>` }] },
  };
}

function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-clientrem-"));
  const db = openStore(path.join(dir, "mail.db"));
  upsertAccount(db, { id: "arcforma", email: "you@example.com" });
  const owners = { ownerAddresses: ["you@example.com"] };
  createCategory(db, { id: "clients", name: "Clients", prompt: "Paying clients." });
  createCategory(db, { id: "vendors", name: "Vendors", prompt: "People we pay." });
  // Dana: a two-way client thread. Sam: wrote in under Clients, never answered. Vic: two-way, but filed under Vendors.
  upsertThreadFromGmail(db, "arcforma", { id: "dana", historyId: "1", messages: [msg("d1", "dana", "Dana Reyes <dana@northwind.example>", "you@example.com", T0 - 3000, ["INBOX"]), msg("d2", "dana", "Oliver <you@example.com>", "dana@northwind.example", T0 - 2000, ["SENT"])] }, owners);
  upsertThreadFromGmail(db, "arcforma", { id: "sam", historyId: "1", messages: [msg("s1", "sam", "Sam <sam@northwind.example>", "you@example.com", T0 - 3000, ["INBOX"])] }, owners);
  upsertThreadFromGmail(db, "arcforma", { id: "vic", historyId: "1", messages: [msg("v1", "vic", "Vic <vic@render.example>", "you@example.com", T0 - 3000, ["INBOX"]), msg("v2", "vic", "Oliver <you@example.com>", "vic@render.example", T0 - 2000, ["SENT"])] }, owners);
  upsertThreadFromGmail(db, "arcforma", { id: "news", historyId: "1", messages: [msg("n1", "news", "Lenny <lenny@substack.example>", "you@example.com", T0 - 3000, ["INBOX"])] }, owners);
  upsertClassification(db, { accountId: "arcforma", threadId: "dana", split: "important", categoryId: "clients", source: "manual" });
  upsertClassification(db, { accountId: "arcforma", threadId: "sam", split: "important", categoryId: "clients", source: "local" });
  upsertClassification(db, { accountId: "arcforma", threadId: "vic", split: "important", categoryId: "vendors", source: "local" });
  upsertClassification(db, { accountId: "arcforma", threadId: "news", split: "other", type: "newsletters", source: "rule" });
  return db;
}

test("the settings carry the reminder rule with its defaults", () => {
  const db = seed();
  assert.equal(DEFAULT_SETTINGS.remindClientsAfterDays, 3);
  assert.deepEqual(DEFAULT_SETTINGS.remindScope, ["Clients"]);
  assert.equal(getSettings(db).remindClientsAfterDays, 3);
  setSetting(db, "remindClientsAfterDays", 0);
  setSetting(db, "remindScope", ["Clients", "Vendors"]);
  assert.equal(getSettings(db).remindClientsAfterDays, 0);
  assert.deepEqual(getSettings(db).remindScope, ["Clients", "Vendors"]);
});

test("scope names resolve to category ids by name or id, case-insensitively, and builtin types by name", () => {
  const db = seed();
  assert.deepEqual(new Set(scopedCategoryIds(db, ["Clients"])), new Set(["clients"]));
  assert.deepEqual(new Set(scopedCategoryIds(db, ["clients", " VENDORS "])), new Set(["clients", "vendors"]));
  assert.ok(scopedCategoryIds(db, ["Newsletters"]).includes("newsletters"), "builtin categories are rows too");
  assert.deepEqual(scopedCategoryIds(db, []), []);
  assert.deepEqual(scopedCategoryIds(db, ["  "]), []);
});

test("threadInCategories and twoWayInCategories read the classification and both directions of mail", () => {
  const db = seed();
  assert.equal(threadInCategories(db, "arcforma", "dana", ["clients"]), true);
  assert.equal(threadInCategories(db, "arcforma", "vic", ["clients"]), false);
  assert.equal(threadInCategories(db, "arcforma", "news", ["newsletters"]), true, "a builtin type counts by its id");
  assert.equal(twoWayInCategories(db, "dana@northwind.example", ["clients"]), true);
  assert.equal(twoWayInCategories(db, "DANA@northwind.example", ["clients"]), true, "case does not matter");
  assert.equal(twoWayInCategories(db, "sam@northwind.example", ["clients"]), false, "Sam wrote once and never got a reply");
  assert.equal(twoWayInCategories(db, "vic@render.example", ["clients"]), false, "Vic is two-way, but under Vendors");
  assert.equal(twoWayInCategories(db, "vic@render.example", ["vendors"]), true);
});

test("clientReminderApplies: the thread in scope, a known client anywhere, a stranger nowhere", () => {
  const db = seed();
  const scope = ["Clients"];
  assert.equal(clientReminderApplies(db, { accountId: "arcforma", threadId: "sam", recipients: ["sam@northwind.example"], scope }), true, "a reply into a Clients thread");
  assert.equal(clientReminderApplies(db, { accountId: "arcforma", threadId: null, recipients: ["dana@northwind.example"], scope }), true, "a new message to a client");
  assert.equal(clientReminderApplies(db, { accountId: "arcforma", threadId: null, recipients: ["stranger@example.com"], scope }), false);
  assert.equal(clientReminderApplies(db, { accountId: "arcforma", threadId: "vic", recipients: ["vic@render.example"], scope }), false, "a vendor is not a client");
  assert.equal(clientReminderApplies(db, { accountId: "arcforma", threadId: "vic", recipients: ["vic@render.example"], scope: ["Vendors"] }), true, "until the scope says so");
  assert.equal(clientReminderApplies(db, { accountId: "arcforma", threadId: "dana", recipients: ["dana@northwind.example"], scope: [] }), false, "an empty scope applies to nothing");
});

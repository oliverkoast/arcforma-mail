import { test } from "node:test";
import assert from "node:assert/strict";
import { accountTip, sidebarRowTip } from "./tips";

test("sidebarRowTip: builtins have a sentence, categories answer with their description, searches with their query", () => {
  const categories = [{ id: "clients", name: "Clients", kind: "custom" as const, prompt: "Mail from paying clients." }, { id: "bare", name: "Bare", kind: "custom" as const, prompt: "" }];
  const searches = [{ id: 3, name: "Northwind", query: "northwind invoice" }];
  assert.match(sidebarRowTip({ id: "daily", kind: "builtin", label: "Daily 0" }, [], []), /^Important threads with new mail/);
  assert.equal(sidebarRowTip({ id: "archive", kind: "builtin", label: "Archive" }, [], []), "Out of the inbox, still in All Mail.");
  assert.equal(sidebarRowTip({ id: "category:clients", kind: "category", ref: "clients", label: "Clients" }, categories, searches), "Category: Mail from paying clients.");
  assert.equal(sidebarRowTip({ id: "category:bare", kind: "category", ref: "bare", label: "Bare" }, categories, searches), "Category Bare. Describe what belongs in Settings.");
  assert.equal(sidebarRowTip({ id: "search:3", kind: "search", ref: "3", label: "Northwind" }, categories, searches), "Saved search: northwind invoice");
});

test("accountTip: the click rules plus the sign-in state", () => {
  assert.match(accountTip({ authState: "ok", syncState: "live", error: null }), /Double-click to open its inbox\.\nSigned in and syncing\./);
  assert.match(accountTip({ authState: "expired", syncState: "live", error: null }), /Sign in again/);
  assert.match(accountTip({ authState: "signed_out", syncState: "live", error: null }), /Signed out/);
  assert.match(accountTip({ authState: "ok", syncState: "backfill", error: null }), /First sync running/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_SIDEBAR_COUNTS, type AccountInfo } from "../../shared/types";

// The store reads window.arcmail at import time; node:test hands it a bridge that records every invoke.
const calls: Array<{ channel: string; args: unknown[] }> = [];
(globalThis as { window?: unknown }).window = {
  arcmail: {
    platform: "test",
    on: () => () => {},
    invoke: async (channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      switch (channel) {
        case "threads:list":
          return { rows: [], nextCursor: null };
        case "sidebar:counts":
          return EMPTY_SIDEBAR_COUNTS;
        case "sidebar:setLayout":
          return undefined;
        default:
          return undefined;
      }
    },
  },
};

const account = (id: string, email: string): AccountInfo => ({ id, email, displayName: null, consent: "internal", authState: "ok", syncState: "live", configured: true, backfill: null, lastSyncAt: null, error: null });
const accounts = [account("arcforma", "you@example.com"), account("formai", "you@example.net"), account("personal", "you@gmail.com")];
const settle = () => new Promise((r) => setTimeout(r, 0));
const lastList = () => calls.filter((c) => c.channel === "threads:list").at(-1)?.args[0] as { view: string; category: string | null; accountIds?: string[] } | undefined;

test("a single click on an account only changes the filter; a double-click also opens that account's Everything view", async () => {
  const { useApp } = await import("./store");
  useApp.setState({ status: { accounts, configPath: "", configError: null }, ready: true });
  useApp.getState().setView("inbox", { category: "clients" });
  await settle();

  useApp.getState().setAccountFilter("formai");
  await settle();
  let s = useApp.getState();
  assert.equal(s.accountFilter, "formai");
  assert.equal(s.view, "inbox");
  assert.equal(s.category, "clients", "a click keeps the current view");
  assert.deepEqual(lastList()?.accountIds, ["formai"]);
  assert.equal(lastList()?.category, "clients");

  useApp.setState({ view: "daily", split: null, category: null, open: { thread: { id: "t1" } } as never, searchQuery: "kickoff" });
  useApp.getState().openAccountInbox("personal");
  await settle();
  s = useApp.getState();
  assert.equal(s.accountFilter, "personal");
  assert.equal(s.view, "inbox");
  assert.equal(s.split, null);
  assert.equal(s.category, null);
  assert.equal(s.open, null, "the reading pane closes; the list is a different account's");
  assert.equal(s.searchQuery, "", "an active search is left");
  assert.equal(s.scope, "list");
  assert.deepEqual(lastList()?.accountIds, ["personal"]);
  assert.equal(lastList()?.view, "inbox");
});

test("the sidebar menu owns the key scope while open and gives it back on close; the layout save goes to the store", async () => {
  const { useApp } = await import("./store");
  useApp.getState().openSidebarMenu({ kind: "add", group: "inbox", anchor: { x: 10, y: 20 } });
  assert.equal(useApp.getState().scope, "sidebar");
  useApp.getState().closeSidebarMenu();
  assert.equal(useApp.getState().scope, "list");
  const layout = { version: 1 as const, groups: [{ id: "queues" as const, rows: [{ id: "daily", hidden: false }] }] };
  await useApp.getState().saveSidebarLayout(layout);
  assert.deepEqual(useApp.getState().sidebarLayout, layout);
  assert.deepEqual(calls.filter((c) => c.channel === "sidebar:setLayout").at(-1)?.args, [layout]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_SIDEBAR_COUNTS, type CategoryInfo, type SavedSearchInfo, type SidebarLayout } from "../../shared/types";
import { defaultLayout, groupOf, hiddenRows, isActiveView, moveRow, reconcileLayout, rowDescriptors, setRowHidden, viewTitle, visibleRows } from "./sidebarLayout";

const categories: CategoryInfo[] = [
  { id: "newsletters", name: "Newsletters", kind: "builtin", prompt: "" },
  { id: "clients", name: "Clients", kind: "custom", prompt: "Paying clients." },
];
const searches: SavedSearchInfo[] = [{ id: 3, name: "Northwind", query: "northwind" }];
const rows = rowDescriptors(categories, searches);
const ids = (layout: SidebarLayout, group: "queues" | "inbox" | "folders") => layout.groups.find((g) => g.id === group)!.rows.map((r) => r.id);

test("descriptors: builtins, the four types, custom categories, and saved searches, each with a view and a count", () => {
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get("category:clients")?.kind, "category");
  assert.equal(byId.get("category:clients")?.ref, "clients");
  assert.equal(byId.get("category:newsletters")?.kind, "builtin", "the four builtin types cannot be renamed or removed");
  assert.equal(byId.get("search:3")?.kind, "search");
  assert.deepEqual(byId.get("search:3")?.view, { view: "search:3" });
  assert.equal(byId.get("search:3")?.count({ ...EMPTY_SIDEBAR_COUNTS, searches: { "3": 7 } }), 7);
  assert.equal(byId.get("category:clients")?.count({ ...EMPTY_SIDEBAR_COUNTS, categories: { clients: 2 } }), 2);
  assert.equal(byId.get("scheduled")?.count({ ...EMPTY_SIDEBAR_COUNTS, scheduled: 1 }), 1);
  assert.equal(byId.get("unread")?.label, "Unread");
  assert.equal(byId.get("attachments")?.label, "With attachments");
  for (const id of ["unread", "attachments", "scheduled", "archive", "spam", "trash"]) assert.ok(byId.has(id), `${id} is a row`);
});

test("the default layout puts every row in its group; Spam and Trash start hidden", () => {
  const layout = defaultLayout(rows);
  assert.deepEqual(ids(layout, "queues"), ["daily", "weekly", "later"]);
  assert.deepEqual(ids(layout, "inbox"), ["inbox", "important", "other", "unread", "attachments", "category:newsletters", "category:calendar", "category:notifications", "category:receipts", "category:clients"]);
  assert.deepEqual(ids(layout, "folders"), ["snoozed", "starred", "sent", "drafts", "scheduled", "archive", "spam", "trash", "search:3"]);
  assert.deepEqual(hiddenRows(layout, rows).map((r) => r.id), ["spam", "trash"]);
  assert.deepEqual(visibleRows(layout, "folders", rows).map((r) => r.id), ["snoozed", "starred", "sent", "drafts", "scheduled", "archive", "search:3"]);
});

test("reconcile: saved order and hidden flags survive, unknown rows drop, new rows append to their default group", () => {
  const saved = {
    version: 1,
    groups: [
      { id: "queues", rows: [{ id: "later", hidden: false }, { id: "daily", hidden: true }] },
      { id: "inbox", rows: [{ id: "category:clients", hidden: false }, { id: "inbox", hidden: false }, { id: "category:gone", hidden: false }] },
      { id: "folders", rows: [{ id: "sent", hidden: false }, { id: "search:99", hidden: false }, { id: "inbox", hidden: true }] },
    ],
  };
  const layout = reconcileLayout(saved, rows);
  assert.deepEqual(ids(layout, "queues"), ["later", "daily", "weekly"], "weekly was never placed, so it appends");
  assert.equal(layout.groups[0]!.rows[1]!.hidden, true, "the hidden flag is kept");
  assert.deepEqual(ids(layout, "inbox").slice(0, 2), ["category:clients", "inbox"]);
  assert.equal(ids(layout, "inbox").includes("category:gone"), false, "a deleted category leaves the layout");
  assert.equal(ids(layout, "folders").includes("search:99"), false, "a deleted saved search leaves the layout");
  assert.equal(ids(layout, "folders").filter((id) => id === "inbox").length, 0, "a row can only be placed once; the first placement wins");
  assert.deepEqual(ids(layout, "folders").slice(0, 1), ["sent"]);
  assert.ok(ids(layout, "folders").includes("search:3"), "the new saved search appends to Folders");
  const appended = layout.groups[2]!.rows.find((r) => r.id === "spam");
  assert.equal(appended?.hidden, true, "a row appended for the first time takes its default visibility");
});

test("reconcile: garbage, an old shape, and null all give the default layout", () => {
  const def = defaultLayout(rows);
  assert.deepEqual(reconcileLayout(null, rows), def);
  assert.deepEqual(reconcileLayout("nope", rows), def);
  assert.deepEqual(reconcileLayout({ version: 1 }, rows), def);
  assert.deepEqual(reconcileLayout({ version: 1, groups: [{ id: "elsewhere", rows: [{ id: "inbox" }] }] }, rows), def, "an unknown group id is ignored");
  const bareIds = reconcileLayout({ version: 1, groups: [{ id: "queues", rows: ["weekly"] }] }, rows);
  assert.deepEqual(ids(bareIds, "queues"), ["weekly", "daily", "later"], "a row given as a bare id string is read as visible");
});

test("moveRow reorders within a group and carries a row into another group, before a row or at the end", () => {
  const layout = defaultLayout(rows);
  const within = moveRow(layout, "later", "queues", "daily");
  assert.deepEqual(ids(within, "queues"), ["later", "daily", "weekly"]);
  const across = moveRow(within, "unread", "queues", "weekly");
  assert.deepEqual(ids(across, "queues"), ["later", "daily", "unread", "weekly"]);
  assert.equal(ids(across, "inbox").includes("unread"), false);
  assert.equal(groupOf(across, "unread"), "queues");
  const toEnd = moveRow(across, "daily", "folders", null);
  assert.equal(ids(toEnd, "folders").at(-1), "daily");
  assert.deepEqual(ids(toEnd, "queues"), ["later", "unread", "weekly"]);
  assert.equal(moveRow(toEnd, "nothing", "queues", null), toEnd, "an unknown row is a no-op");
  assert.equal(moveRow(toEnd, "later", "queues", "later"), toEnd, "dropping a row on itself is a no-op");
  const before = moveRow(toEnd, "later", "inbox", "important");
  assert.deepEqual(ids(before, "inbox").slice(0, 3), ["inbox", "later", "important"]);
  const unknownTarget = moveRow(before, "later", "inbox", "not-here");
  assert.equal(ids(unknownTarget, "inbox").at(-1), "later", "an unknown beforeId lands at the end");
});

test("hide and show flip one row and nothing else; a hidden row keeps its place", () => {
  const layout = defaultLayout(rows);
  const hidden = setRowHidden(layout, "sent", true);
  assert.deepEqual(hiddenRows(hidden, rows).map((r) => r.id), ["sent", "spam", "trash"]);
  assert.deepEqual(ids(hidden, "folders"), ids(layout, "folders"), "hiding does not reorder");
  const shown = setRowHidden(hidden, "spam", false);
  assert.deepEqual(hiddenRows(shown, rows).map((r) => r.id), ["sent", "trash"]);
  assert.deepEqual(visibleRows(shown, "folders", rows).map((r) => r.id), ["snoozed", "starred", "drafts", "scheduled", "archive", "spam", "search:3"]);
});

test("the active row follows view, split, and category exactly; the list title comes from the row", () => {
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(isActiveView(byId.get("inbox")!.view, { view: "inbox", split: null, category: null }), true);
  assert.equal(isActiveView(byId.get("inbox")!.view, { view: "inbox", split: "important", category: null }), false);
  assert.equal(isActiveView(byId.get("important")!.view, { view: "inbox", split: "important", category: null }), true);
  assert.equal(isActiveView(byId.get("category:clients")!.view, { view: "inbox", split: null, category: "clients" }), true);
  assert.equal(isActiveView(byId.get("search:3")!.view, { view: "search:3", split: null, category: null }), true);
  assert.equal(viewTitle(rows, { view: "search:3", split: null, category: null }), "Northwind");
  assert.equal(viewTitle(rows, { view: "attachments", split: null, category: null }), "With attachments");
  assert.equal(viewTitle(rows, { view: "all", split: null, category: null }), null);
});

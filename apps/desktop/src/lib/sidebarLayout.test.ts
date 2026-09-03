import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_SIDEBAR_COUNTS, type CategoryInfo, type SavedSearchInfo, type SidebarLayout } from "../../shared/types";
import { defaultLayout, groupOf, hiddenRows, isActiveView, moveRow, reconcileLayout, rowDescriptors, setRowHidden, viewTitle, visibleRows, rowsToShow } from "./sidebarLayout";
import { sidebarRowTip } from "./tips";

const categories: CategoryInfo[] = [
  { id: "newsletters", name: "Newsletters", kind: "builtin", prompt: "" },
  { id: "clients", name: "Clients", kind: "custom", prompt: "Paying clients." },
];
const searches: SavedSearchInfo[] = [{ id: 3, name: "Northwind", query: "northwind" }];
const rows = rowDescriptors(categories, searches);
const ids = (layout: SidebarLayout, group: "queues" | "inbox" | "folders") => layout.groups.find((g) => g.id === group)!.rows.map((r) => r.id);

test("descriptors: builtins, the six types, custom categories, and saved searches, each with a view and a count", () => {
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get("category:clients")?.kind, "category");
  assert.equal(byId.get("category:clients")?.ref, "clients");
  assert.equal(byId.get("category:newsletters")?.kind, "builtin", "the six builtin types cannot be renamed or removed");
  for (const id of ["newsletters", "promotions", "jobs", "calendar", "notifications", "receipts"]) assert.ok(byId.has(`category:${id}`), `${id} is a row`);
  assert.equal(byId.get("category:promotions")?.count({ ...EMPTY_SIDEBAR_COUNTS, categories: { promotions: 4 } }), 4);
  assert.equal(byId.get("category:jobs")?.count({ ...EMPTY_SIDEBAR_COUNTS, categories: { jobs: 9 } }), 9);
  assert.equal(byId.get("search:3")?.kind, "search");
  assert.deepEqual(byId.get("search:3")?.view, { view: "search:3" });
  assert.equal(byId.get("search:3")?.count({ ...EMPTY_SIDEBAR_COUNTS, searches: { "3": 7 } }), 7);
  assert.equal(byId.get("category:clients")?.count({ ...EMPTY_SIDEBAR_COUNTS, categories: { clients: 2 } }), 2);
  assert.equal(byId.get("scheduled")?.count({ ...EMPTY_SIDEBAR_COUNTS, scheduled: 1 }), 1);
  assert.equal(byId.get("unread")?.label, "Unread");
  assert.equal(byId.get("attachments")?.label, "With attachments");
  for (const id of ["unread", "attachments", "scheduled", "archive", "spam", "trash"]) assert.ok(byId.has(id), `${id} is a row`);
});

test("Needs you: the row leads the Queues group, counts its own threads, and says what it holds", () => {
  const row = rows.find((r) => r.id === "needsyou")!;
  assert.equal(row.label, "Needs you");
  assert.equal(row.group, "queues");
  assert.deepEqual(row.view, { view: "needsyou" });
  assert.equal(row.count({ ...EMPTY_SIDEBAR_COUNTS, needsYou: 4 }), 4);
  assert.equal(row.count(EMPTY_SIDEBAR_COUNTS), 0, "an empty row shows no count at all");
  assert.equal(row.hiddenByDefault, undefined, "the one row he asked for is not hidden to start with");
  assert.equal(defaultLayout(rows).groups.find((g) => g.id === "queues")!.rows[0]!.id, "needsyou");
  // A layout saved before the row existed gains it at the head of Queues rather than under Later.
  const saved = { version: 1, groups: [{ id: "queues", rows: [{ id: "daily", hidden: false }, { id: "weekly", hidden: false }, { id: "later", hidden: false }] }] };
  assert.deepEqual(ids(reconcileLayout(saved, rows), "queues"), ["needsyou", "daily", "weekly", "later"]);
  // The tooltip has to be honest about the rule, because the row is a promise.
  const tip = sidebarRowTip(row, categories, searches);
  assert.match(tip, /asked you something/);
  assert.match(tip, /have not replied/);
  assert.equal(isActiveView(row.view, { view: "needsyou", split: null, category: null }), true);
  assert.equal(isActiveView(row.view, { view: "inbox", split: "important", category: null }), false, "Important is a different list");
  assert.equal(viewTitle(rows, { view: "needsyou", split: null, category: null }), "Needs you");
});

test("the default layout puts every row in its group; Spam and Trash start hidden", () => {
  const layout = defaultLayout(rows);
  assert.deepEqual(ids(layout, "queues"), ["needsyou", "daily", "weekly", "later"], "Needs you leads the queues");
  assert.deepEqual(ids(layout, "inbox"), ["inbox", "important", "other", "unread", "attachments", "category:newsletters", "category:promotions", "category:jobs", "category:calendar", "category:notifications", "category:receipts", "category:clients"]);
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
  assert.deepEqual(ids(layout, "queues"), ["needsyou", "later", "daily", "weekly"], "weekly was never placed, so it appends; Needs you goes to the head of its group instead");
  assert.equal(layout.groups[0]!.rows.find((r) => r.id === "daily")!.hidden, true, "the hidden flag is kept");
  assert.deepEqual(ids(layout, "inbox").slice(0, 2), ["category:clients", "inbox"]);
  assert.equal(ids(layout, "inbox").includes("category:gone"), false, "a deleted category leaves the layout");
  assert.equal(ids(layout, "folders").includes("search:99"), false, "a deleted saved search leaves the layout");
  assert.equal(ids(layout, "folders").filter((id) => id === "inbox").length, 0, "a row can only be placed once; the first placement wins");
  assert.deepEqual(ids(layout, "folders").slice(0, 1), ["sent"]);
  assert.ok(ids(layout, "folders").includes("search:3"), "the new saved search appends to Folders");
  const appended = layout.groups[2]!.rows.find((r) => r.id === "spam");
  assert.equal(appended?.hidden, true, "a row appended for the first time takes its default visibility");
});

test("reconcile: Promotions and Jobs reach a layout saved before they existed, without disturbing it", () => {
  // A layout written when the sidebar had four types: Newsletters hidden, Receipts pulled to the
  // top of the group, Calendar moved out to Folders, and one custom category in the middle.
  const saved = {
    version: 1,
    groups: [
      { id: "queues", rows: [{ id: "daily", hidden: false }, { id: "weekly", hidden: false }, { id: "later", hidden: false }] },
      {
        id: "inbox",
        rows: [
          { id: "category:receipts", hidden: false },
          { id: "inbox", hidden: false },
          { id: "important", hidden: false },
          { id: "other", hidden: true },
          { id: "unread", hidden: false },
          { id: "attachments", hidden: false },
          { id: "category:newsletters", hidden: true },
          { id: "category:clients", hidden: false },
          { id: "category:notifications", hidden: false },
        ],
      },
      { id: "folders", rows: [{ id: "category:calendar", hidden: false }, { id: "snoozed", hidden: false }, { id: "starred", hidden: false }, { id: "sent", hidden: false }, { id: "drafts", hidden: false }, { id: "scheduled", hidden: false }, { id: "archive", hidden: false }] },
    ],
  };
  const layout = reconcileLayout(saved, rows);
  const inbox = ids(layout, "inbox");
  assert.ok(inbox.includes("category:promotions"), "Promotions appears rather than being dropped");
  assert.ok(inbox.includes("category:jobs"), "Jobs appears rather than being dropped");
  // They land behind Newsletters, in their own order, not at the end under the custom category.
  assert.deepEqual(inbox.slice(inbox.indexOf("category:newsletters"), inbox.indexOf("category:newsletters") + 3), ["category:newsletters", "category:promotions", "category:jobs"]);
  // Everything the user arranged is untouched.
  assert.equal(inbox[0], "category:receipts", "the row pulled to the top stays there");
  assert.deepEqual(inbox.slice(1, 6), ["inbox", "important", "other", "unread"].concat(["attachments"]));
  assert.equal(groupOf(layout, "category:calendar"), "folders", "a type moved to another group stays there");
  assert.deepEqual(hiddenRows(layout, rows).map((r) => r.id), ["other", "category:newsletters", "spam", "trash"], "hidden rows stay hidden, and the new rows arrive visible");
  assert.equal(inbox.at(-1), "category:notifications", "the custom category keeps its place ahead of the row that followed it");
  assert.ok(inbox.indexOf("category:clients") < inbox.indexOf("category:notifications"));
});

test("reconcile: garbage, an old shape, and null all give the default layout", () => {
  const def = defaultLayout(rows);
  assert.deepEqual(reconcileLayout(null, rows), def);
  assert.deepEqual(reconcileLayout("nope", rows), def);
  assert.deepEqual(reconcileLayout({ version: 1 }, rows), def);
  assert.deepEqual(reconcileLayout({ version: 1, groups: [{ id: "elsewhere", rows: [{ id: "inbox" }] }] }, rows), def, "an unknown group id is ignored");
  const bareIds = reconcileLayout({ version: 1, groups: [{ id: "queues", rows: ["weekly"] }] }, rows);
  assert.deepEqual(ids(bareIds, "queues"), ["needsyou", "weekly", "daily", "later"], "a row given as a bare id string is read as visible");
});

test("moveRow reorders within a group and carries a row into another group, before a row or at the end", () => {
  const layout = defaultLayout(rows);
  const within = moveRow(layout, "later", "queues", "daily");
  assert.deepEqual(ids(within, "queues"), ["needsyou", "later", "daily", "weekly"]);
  const across = moveRow(within, "unread", "queues", "weekly");
  assert.deepEqual(ids(across, "queues"), ["needsyou", "later", "daily", "unread", "weekly"]);
  assert.equal(ids(across, "inbox").includes("unread"), false);
  assert.equal(groupOf(across, "unread"), "queues");
  const toEnd = moveRow(across, "daily", "folders", null);
  assert.equal(ids(toEnd, "folders").at(-1), "daily");
  assert.deepEqual(ids(toEnd, "queues"), ["needsyou", "later", "unread", "weekly"]);
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

test("Archive became Done in the interface only: a layout that hid or reordered it keeps exactly that", () => {
  // What the row is called changed; its stored id did not, so nothing saved has to be migrated.
  assert.equal(rows.find((r) => r.id === "archive")?.label, "Done");
  assert.deepEqual(rows.find((r) => r.id === "archive")?.view, { view: "archive" });
  assert.equal(rows.find((r) => r.id === "archive")?.hiddenByDefault, undefined, "it shows unless someone hid it");
  assert.ok(ids(defaultLayout(rows), "folders").includes("archive"), "and it is in Folders out of the box");

  // Someone who hid the row back when it read Archive still has it hidden.
  const hidden = reconcileLayout({ version: 1, groups: [{ id: "folders", rows: [{ id: "archive", hidden: true }, { id: "starred", hidden: false }] }] }, rows);
  const archiveRow = hidden.groups.find((g) => g.id === "folders")!.rows.find((r) => r.id === "archive");
  assert.equal(archiveRow?.hidden, true);
  assert.ok(!visibleRows(hidden, "folders", rows).some((r) => r.id === "archive"), "a hidden row does not come back under a new name");
  assert.ok(hiddenRows(hidden, rows).some((r) => r.label === "Done"), "and it offers itself as Done when shown again");

  // Someone who dragged it to the top of Folders, or into another group, still has it there.
  const reordered = reconcileLayout({ version: 1, groups: [{ id: "folders", rows: [{ id: "archive", hidden: false }, { id: "snoozed", hidden: false }, { id: "starred", hidden: false }] }] }, rows);
  assert.equal(ids(reordered, "folders")[0], "archive", "still first");
  const moved = reconcileLayout({ version: 1, groups: [{ id: "queues", rows: [{ id: "archive", hidden: false }, { id: "daily", hidden: false }] }] }, rows);
  assert.equal(groupOf(moved, "archive"), "queues");
  assert.ok(visibleRows(moved, "queues", rows).some((r) => r.label === "Done"), "and it shows there, as Done");
});

test("a row holding nothing folds away, unless it is pinned, active, or the group is opened", () => {
  const rows = rowDescriptors([], []);
  const empty = () => 0;
  const none = () => false;
  const pinned = rows.filter((r) => r.alwaysShown === true).map((r) => r.id);
  assert.deepEqual(rowsToShow(rows, empty, none, false).shown.map((r) => r.id), pinned,
    "with an empty mailbox the sidebar is only the rows that earn their place empty");
  assert.ok(rowsToShow(rows, empty, none, false).folded > 0, "the rest are counted, not lost");
  assert.equal(rowsToShow(rows, empty, none, true).shown.length, rows.length, "opening the group shows everything");

  const unread = rows.find((r) => r.id === "unread");
  assert.ok(unread, "unread is a row");
  assert.ok(!rowsToShow(rows, empty, none, false).shown.includes(unread), "an empty filter folds");
  assert.ok(rowsToShow(rows, (r) => (r.id === "unread" ? 3 : 0), none, false).shown.includes(unread), "a filter with mail in it shows");
  assert.ok(rowsToShow(rows, empty, (r) => r.id === "unread", false).shown.includes(unread), "the view being read always shows");
});

test("the pinned rows are the ones that answer where am I, not the filters", () => {
  const ids = rowDescriptors([], []).filter((r) => r.alwaysShown === true).map((r) => r.id).sort();
  assert.deepEqual(ids, ["archive", "daily", "drafts", "important", "inbox", "needsyou", "other", "sent"]);
});

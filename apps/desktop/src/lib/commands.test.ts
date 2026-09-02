import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommands, filterCommands, fuzzyScore, sidebarCommands, type CommandSource } from "./commands";
import { KEYMAP } from "../keys/keymap";
import type { AccountInfo, CategoryInfo } from "../../shared/types";

const account = (id: string, email: string, authState: AccountInfo["authState"]): AccountInfo => ({ id, email, displayName: null, consent: "internal", authState, syncState: "live", configured: true, backfill: null, lastSyncAt: null, error: null });
const categories: CategoryInfo[] = [
  { id: "newsletters", name: "Newsletters", kind: "builtin", prompt: "" },
  { id: "clients", name: "Clients", kind: "custom", prompt: "Mail from paying clients." },
  { id: "vendors", name: "Vendors", kind: "custom", prompt: "Invoices and vendor mail." },
];

function source(over: Partial<CommandSource> = {}): CommandSource {
  return {
    scope: "list",
    categories,
    savedSearches: [{ id: 3, name: "Northwind", query: "northwind invoice" }],
    sidebarLayout: null,
    accounts: [account("arcforma", "you@example.com", "ok"), account("formai", "you@example.net", "signed_out")],
    snippets: [{ id: 1, trigger: "thanks", name: "Thanks and next step", bodyHtml: "<p>Thanks</p>", bodyText: "Thanks" }],
    thread: { canUnsubscribe: false, queue: null, starred: false },
    ...over,
  };
}

test("fuzzyScore: subsequence match, word starts and runs score higher, no match is null", () => {
  assert.equal(fuzzyScore("xyz", "Snooze until tomorrow"), null);
  assert.equal(fuzzyScore("", "anything"), 0);
  const snooze = fuzzyScore("sno", "Snooze until tomorrow")!;
  const signIn = fuzzyScore("sno", "Sign in you@example.net")!;
  assert.ok(snooze > signIn, `a run at the start beats scattered letters: ${snooze} vs ${signIn}`);
  const wordStarts = fuzzyScore("rp", "Show or hide the reading pane")!;
  const inside = fuzzyScore("rp", "Unsubscribe and archive")!;
  assert.ok(wordStarts > inside, `word starts beat letters inside a word: ${wordStarts} vs ${inside}`);
  assert.ok(fuzzyScore("SNO", "snooze")! > 0, "case does not matter");
  assert.ok(fuzzyScore("s n o", "snooze")! > 0, "spaces in the query are ignored");
  assert.ok(fuzzyScore("open daily", "Open Daily 0")! > fuzzyScore("open daily", "Open Weekly 0")!, "a second word that matches at a word start ranks above one that has to reach into the label");
});

test("the registry lists every keymap command once with its label and key, thread commands only when there is a thread", () => {
  const cmds = buildCommands(source());
  const ids = cmds.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate ids");
  const byId = new Map(cmds.map((c) => [c.id, c]));
  assert.equal(byId.get("action:archive")?.label, "Mark done");
  assert.equal(byId.get("action:archive")?.key, "E");
  assert.equal(byId.get("action:compose")?.key, "C");
  assert.equal(byId.get("action:snoozeTomorrow")?.label, "Snooze until tomorrow");
  assert.equal(byId.get("action:snoozeTomorrow")?.key, "H T");
  assert.equal(byId.get("action:snoozeNextWeek")?.label, "Snooze until next week");
  assert.equal(byId.get("action:snoozePick")?.label, "Snooze until a date you pick");
  assert.equal(byId.get("action:toggleDaily")?.label, "Add to Daily 0");
  assert.equal(byId.get("action:toggleWeekly")?.label, "Add to Weekly 0");
  assert.equal(byId.get("action:toggleReadingPane")?.label, "Show or hide the reading pane");
  assert.equal(byId.get("action:toggleReadingPane")?.key, "Cmd+\\");
  assert.equal(byId.get("action:toggleCalendar")?.label, "Toggle calendar rail");
  assert.equal(byId.get("action:toggleContact")?.label, "Toggle contact rail");
  assert.equal(byId.get("action:settings")?.label, "Settings");
  assert.equal(byId.get("action:settings")?.key, "Cmd+,");
  assert.equal(byId.get("action:ask")?.key, "Cmd+Shift+A");
  assert.ok(!byId.has("action:next"), "J is a key, not a command");
  assert.ok(!byId.has("action:palette"), "the palette does not list itself");
  assert.ok(!byId.has("action:unsubscribe"), "no unsubscribe command without a link");

  const withLink = buildCommands(source({ thread: { canUnsubscribe: true, queue: "daily", starred: true } }));
  const linked = new Map(withLink.map((c) => [c.id, c]));
  assert.equal(linked.get("action:unsubscribe")?.label, "Unsubscribe and archive");
  assert.equal(linked.get("action:unsubscribe")?.key, "U");
  assert.equal(linked.get("action:toggleDaily")?.label, "Remove from Daily 0");
  assert.equal(linked.get("action:star")?.label, "Unstar");

  const empty = buildCommands(source({ thread: null }));
  assert.ok(!empty.some((c) => c.id === "action:archive"), "nothing to mark done in an empty list");
  assert.ok(!empty.some((c) => c.id.startsWith("move:")), "nothing to move");
  assert.ok(empty.some((c) => c.id === "action:compose"), "compose still there");

  // Every keymap action reachable from the list, thread, global, or popover scopes either lists or is deliberately a key only.
  const keyOnly = new Set(["next", "prev", "open", "close", "closePopover", "palette", "closePalette", "instantReply1", "instantReply2", "instantReply3"]);
  for (const b of KEYMAP.filter((b) => ["list", "thread", "global", "popover"].includes(b.scope))) {
    if (keyOnly.has(b.action)) continue;
    assert.ok(linked.has(`action:${b.action}`), `${b.action} is in the palette`);
  }
});

test("dynamic commands: Move to each custom category, Open each visible sidebar row, Sign in for signed-out accounts", () => {
  const cmds = buildCommands(source());
  const labels = cmds.map((c) => c.label);
  assert.ok(labels.includes("Move to Clients"));
  assert.ok(labels.includes("Move to Vendors"));
  assert.ok(!labels.includes("Move to Newsletters"), "builtin types are not move targets");
  assert.deepEqual(cmds.find((c) => c.label === "Move to Clients")?.run, { kind: "moveTo", categoryId: "clients" });
  for (const view of ["Daily 0", "Weekly 0", "Later", "Everything", "Important", "Other", "Unread", "Newsletters", "Clients", "Vendors", "Snoozed", "Starred", "Sent", "Drafts", "Scheduled", "Archive", "Northwind"]) {
    assert.ok(labels.includes(`Open ${view}`), `Open ${view}`);
  }
  assert.ok(!labels.includes("Open Spam"), "hidden rows do not list");
  assert.deepEqual(cmds.find((c) => c.label === "Open Important")?.run, { kind: "openView", view: { view: "inbox", split: "important" } });
  assert.deepEqual(cmds.find((c) => c.label === "Open Northwind")?.run, { kind: "openView", view: { view: "search:3" } });
  assert.ok(labels.includes("Sign in you@example.net"));
  assert.ok(!labels.includes("Sign in you@example.com"), "a signed-in account has no sign-in command");
  assert.deepEqual(cmds.find((c) => c.label === "Sign in you@example.net")?.run, { kind: "signIn", accountId: "formai" });

  // A layout that hides Sent and moves Trash into view changes the Open rows.
  const layout = { version: 1 as const, groups: [{ id: "queues" as const, rows: [{ id: "daily", hidden: false }] }, { id: "inbox" as const, rows: [] }, { id: "folders" as const, rows: [{ id: "sent", hidden: true }, { id: "trash", hidden: false }] }] };
  const rows = sidebarCommands({ categories, savedSearches: [], sidebarLayout: layout }).map((c) => c.label);
  assert.ok(!rows.includes("Open Sent"));
  assert.ok(rows.includes("Open Trash"));
  assert.ok(rows.includes("Open Clients"), "a category the layout never saw still appends");
});

test("the compose scope gets Send, Send later, Discard, and Insert snippet for each snippet", () => {
  const cmds = buildCommands(source({ scope: "compose" }));
  assert.deepEqual(
    cmds.map((c) => [c.label, c.key]),
    [
      ["Send", "Cmd+Enter"],
      ["Send later", "Cmd+Shift+Enter"],
      ["Discard draft", "Cmd+Shift+D"],
      ["Insert snippet Thanks and next step", ";thanks"],
    ]
  );
  assert.deepEqual(cmds[3]?.run, { kind: "insertSnippet", snippetId: 1 });
});

test("filterCommands: top eight, snooze first for 'sno', and Search for <text> closes the list when the text is not a command", () => {
  const cmds = buildCommands(source());
  assert.equal(filterCommands(cmds, "").length, 8);
  assert.equal(filterCommands(cmds, "")[0]?.label, "Compose", "registry order when nothing is typed");
  const sno = filterCommands(cmds, "sno");
  assert.equal(sno[0]?.label, "Snooze");
  assert.equal(sno[1]?.label, "Snooze until tomorrow");
  assert.ok(sno.length <= 8);
  assert.equal(sno.at(-1)?.label, "Search for sno");
  assert.deepEqual(sno.at(-1)?.run, { kind: "search", query: "sno" });
  const exact = filterCommands(cmds, "settings");
  assert.equal(exact[0]?.label, "Settings");
  assert.ok(!exact.some((c) => c.id === "search"), "an exact command needs no search row");
  const none = filterCommands(cmds, "from:dana has:attachment");
  assert.equal(none.length, 1);
  assert.equal(none[0]?.label, "Search for from:dana has:attachment");
});

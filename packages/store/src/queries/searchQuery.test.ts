import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  compileSearch,
  createCategory,
  createSavedSearch,
  createSnooze,
  isEmptySearch,
  openStore,
  parseSearchDate,
  parseSearchQuery,
  parseSearchWindow,
  saveBody,
  savedSearchCount,
  search,
  searchCount,
  setQueue,
  setSetting,
  toFtsMatch,
  upsertAccount,
  upsertClassification,
  upsertLabels,
  upsertThreadFromGmail,
  type GmailThreadInput,
} from "../index.js";

const T0 = new Date(2026, 8, 1, 12, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function msg(id: string, threadId: string, from: string, to: string, subject: string, date: number, labels: string[], extra: { cc?: string; attachment?: boolean } = {}) {
  return {
    id,
    threadId,
    labelIds: labels,
    snippet: "",
    internalDate: String(date),
    historyId: "1",
    payload: {
      mimeType: extra.attachment ? "multipart/mixed" : "text/plain",
      headers: [
        { name: "From", value: from },
        { name: "To", value: to },
        { name: "Subject", value: subject },
        { name: "Message-ID", value: `<${id}@x>` },
        ...(extra.cc ? [{ name: "Cc", value: extra.cc }] : []),
      ],
      parts: extra.attachment ? [{ mimeType: "application/pdf", filename: "deck.pdf", body: { attachmentId: "a1", size: 10 } }] : [],
    },
  };
}

function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-search-"));
  const db = openStore(path.join(dir, "mail.db"));
  upsertAccount(db, { id: "arcforma", email: "you@example.com" });
  upsertAccount(db, { id: "personal", email: "you@gmail.com" });
  const owners = { ownerAddresses: ["you@example.com", "you@gmail.com"] };
  const threads: Array<[string, GmailThreadInput]> = [
    [
      "arcforma",
      {
        id: "kickoff",
        historyId: "1",
        messages: [
          msg("k1", "kickoff", "Dana Reyes <dana@northwind.example>", "you@example.com", "Kickoff next week", T0 - 3 * DAY, ["INBOX", "UNREAD"], { cc: "Priya Shah <priya@northwind.example>" }),
          msg("k2", "kickoff", "Oliver Korzen <you@example.com>", "dana@northwind.example", "Re: Kickoff next week", T0 - 2 * DAY, ["SENT"], { cc: "priya@northwind.example" }),
        ],
      },
    ],
    ["arcforma", { id: "invoice", historyId: "1", messages: [msg("i1", "invoice", "Maya Glenn <maya@arcforma.ai>", "you@example.com", "Invoice for August", T0 - 10 * DAY, ["INBOX", "STARRED"], { attachment: true })] }],
    ["arcforma", { id: "news", historyId: "1", messages: [msg("n1", "news", "Lenny <lenny@substack.example>", "you@example.com", "Kickoff your Q4 planning", T0 - 40 * DAY, [])] }],
    ["personal", { id: "weekend", historyId: "1", messages: [msg("w1", "weekend", "friend@example.com", "you@gmail.com", "Weekend plans", T0 - 1 * DAY, ["INBOX"])] }],
    ["arcforma", { id: "junk", historyId: "1", messages: [msg("j1", "junk", "spam@example.com", "you@example.com", "Kickoff prize", T0, ["SPAM"])] }],
  ];
  for (const [acct, t] of threads) upsertThreadFromGmail(db, acct, t, owners);
  saveBody(db, "arcforma", "k1", { text: "We are set for Tuesday. Could you send the session plan and the first invoice before then?", attachments: [] });
  saveBody(db, "arcforma", "n1", { text: "Planning season is here. Read the kickoff guide.", attachments: [] });
  createCategory(db, { id: "clients", name: "Clients", prompt: "Paying clients." });
  upsertClassification(db, { accountId: "arcforma", threadId: "kickoff", split: "important", categoryId: "clients", source: "manual" });
  upsertClassification(db, { accountId: "arcforma", threadId: "news", split: "other", type: "newsletters", source: "rule" });
  upsertLabels(db, "arcforma", [{ id: "Label_7", name: "Arcforma/Snoozed" }]);
  return db;
}

test("parseSearchQuery reads every operator, quoted values, phrases, and free words", () => {
  const p = parseSearchQuery('from:dana to:"Maya Glenn" cc:priya subject:invoice has:attachment is:unread is:starred in:archive before:2026-09-01 after:2026/08/01 newer_than:7d older_than:2w label:Clients category:newsletters "session plan" kickoff Q4');
  assert.deepEqual(p.from, ["dana"]);
  assert.deepEqual(p.to, ["Maya Glenn"]);
  assert.deepEqual(p.cc, ["priya"]);
  assert.deepEqual(p.subject, ["invoice"]);
  assert.equal(p.hasAttachment, true);
  assert.equal(p.isUnread, true);
  assert.equal(p.isStarred, true);
  assert.equal(p.in, "archive");
  assert.equal(p.before, new Date(2026, 8, 1).getTime());
  assert.equal(p.after, new Date(2026, 7, 1).getTime());
  assert.equal(p.newerThan, 7 * DAY);
  assert.equal(p.olderThan, 14 * DAY);
  assert.deepEqual(p.labels, ["clients", "newsletters"]);
  assert.deepEqual(p.phrases, ["session plan"]);
  assert.deepEqual(p.text, ["kickoff", "Q4"]);
  assert.deepEqual(p.ignored, []);
  assert.equal(isEmptySearch(p), false);
});

test("bad dates, unknown values, and unknown operators degrade without breaking the query", () => {
  const p = parseSearchQuery("before:2026-13-40 after:yesterday newer_than:soon is:purple has:wings in:limbo foo:bar plan");
  assert.equal(p.before, null);
  assert.equal(p.after, null);
  assert.equal(p.newerThan, null);
  assert.equal(p.in, null);
  assert.deepEqual(p.ignored, ["before:2026-13-40", "after:yesterday", "newer_than:soon", "is:purple", "has:wings", "in:limbo"]);
  assert.deepEqual(p.text, ["foo:bar", "plan"], "an operator the syntax does not know is searched as text");
  assert.equal(parseSearchDate("2026-02-30"), null, "February 30 is not a date");
  assert.equal(parseSearchDate("2026-02-28"), new Date(2026, 1, 28).getTime());
  assert.equal(parseSearchWindow("0d"), null);
  assert.equal(parseSearchWindow("1m"), 30 * DAY);
  assert.equal(parseSearchWindow("1y"), 365 * DAY);
  assert.equal(isEmptySearch(parseSearchQuery("")), true);
  assert.equal(isEmptySearch(parseSearchQuery("   ")), true);
  assert.equal(isEmptySearch(parseSearchQuery("is:unread")), false, "a filter alone is a query");
});

test("toFtsMatch and compileSearch build a MATCH plus predicates that hold the FTS5 syntax at bay", () => {
  const p = parseSearchQuery('from:dana@northwind.example subject:"re: kickoff" "session plan" kick OR NOT');
  assert.equal(toFtsMatch(p), '"kick"* "OR"* "NOT"* "session plan" from_text : "dana@northwind.example"* subject : "re: kickoff"*');
  const c = compileSearch(parseSearchQuery("is:unread has:attachment to:maya"), { accountIds: ["arcforma"] });
  assert.equal(c.fts, null);
  assert.ok(c.where.some((w) => w.includes("t.unread = 1")));
  assert.ok(c.where.some((w) => w.includes("t.has_attachments = 1")));
  assert.ok(c.where.some((w) => w.includes("json_each(m.to_json)")));
  assert.deepEqual(c.args, ["arcforma", "%maya%", "%maya%"]);
});

test("compiled queries run on fixtures: words, from, to, cc, subject, phrases", () => {
  const db = seed();
  const ids = (q: string, accountIds?: string[]) => search(db, q, { accountIds, now: T0 }).map((h) => `${h.row.account_id}:${h.row.id}`);
  assert.deepEqual(new Set(ids("kickoff")), new Set(["arcforma:kickoff", "arcforma:news"]), "spam never shows");
  assert.deepEqual(ids("from:dana"), ["arcforma:kickoff"]);
  assert.deepEqual(ids("from:lenny kickoff"), ["arcforma:news"]);
  assert.deepEqual(ids("to:dana"), ["arcforma:kickoff"], "to: reads the To list, so Oliver's reply to Dana matches");
  assert.deepEqual(ids("to:maya"), [], "Maya wrote in, nobody wrote to her");
  assert.deepEqual(ids("cc:priya"), ["arcforma:kickoff"]);
  assert.deepEqual(ids("subject:invoice"), ["arcforma:invoice"], "subject: skips the body mention of an invoice");
  assert.deepEqual(ids('"session plan"'), ["arcforma:kickoff"]);
  assert.deepEqual(ids('"plan session"'), [], "a phrase keeps its word order");
  assert.deepEqual(ids("weekend"), ["personal:weekend"]);
  assert.deepEqual(ids("weekend", ["arcforma"]), [], "the account scope holds");
});

test("compiled queries run on fixtures: flags, folders, dates, labels, and queues", () => {
  const db = seed();
  const ids = (q: string) => search(db, q, { now: T0 }).map((h) => h.row.id);
  assert.deepEqual(ids("is:unread"), ["kickoff"]);
  assert.deepEqual(ids("is:starred"), ["invoice"]);
  assert.deepEqual(ids("has:attachment"), ["invoice"]);
  assert.deepEqual(ids("in:archive"), ["news"]);
  assert.deepEqual(ids("in:inbox"), ["weekend", "kickoff", "invoice"], "newest first when there is nothing to rank");
  assert.deepEqual(ids("before:2026-08-20"), ["news"]);
  assert.deepEqual(ids("before:2026-08-25"), ["invoice", "news"], "August 22 is before August 25");
  assert.deepEqual(ids("after:2026-08-30 kickoff"), ["kickoff"]);
  assert.deepEqual(ids("newer_than:2d"), ["weekend", "kickoff"], "the reply two days ago counts");
  assert.deepEqual(ids("older_than:1m"), ["news"]);
  assert.deepEqual(ids("label:clients"), ["kickoff"], "a custom category by id");
  assert.deepEqual(ids("category:Clients"), ["kickoff"], "or by name");
  assert.deepEqual(ids("label:newsletters"), ["news"], "a builtin type");
  assert.deepEqual(ids("label:starred"), ["invoice"], "a Gmail system label");
  createSnooze(db, { accountId: "arcforma", threadId: "invoice", wakeAt: T0 + DAY });
  assert.deepEqual(ids("in:snoozed"), ["invoice"]);
  assert.deepEqual(ids("in:inbox"), ["weekend", "kickoff"], "a sleeping thread is not in the inbox");
  assert.deepEqual(ids("label:arcforma/snoozed"), [], "the label is pending in the outbox, not on the thread yet");
  setSetting(db, "dayStartAt", T0 - 5 * DAY);
  setQueue(db, "arcforma", "news", "weekly", "user", T0);
  assert.deepEqual(ids("in:daily"), ["kickoff"], "important, in the inbox, inbound since the day started");
  assert.deepEqual(ids("in:weekly"), ["news"]);
  assert.deepEqual(ids("in:daily is:starred"), []);
  assert.deepEqual(ids("before:not-a-date kickoff from:dana"), ["kickoff"], "the bad date is dropped and the rest runs");
});

test("hits carry a marked highlight and say which field matched", () => {
  const db = seed();
  const byId = (q: string) => Object.fromEntries(search(db, q, { now: T0 }).map((h) => [h.row.id, h]));
  const subject = byId("kickoff")["kickoff"]!;
  assert.equal(subject.highlight.field, "subject");
  assert.match(subject.highlight.text, new RegExp(`^(Re: )?${HIGHLIGHT_START}Kickoff${HIGHLIGHT_END} next week$`));
  const body = byId("tuesday")["kickoff"]!;
  assert.equal(body.highlight.field, "body");
  assert.match(body.highlight.text, new RegExp(`${HIGHLIGHT_START}Tuesday${HIGHLIGHT_END}`));
  assert.equal(body.excerpt.includes(HIGHLIGHT_START), false, "the excerpt Ask AI reads stays plain");
  const from = byId("from:lenny")["news"]!;
  assert.equal(from.highlight.field, "from");
  assert.match(from.highlight.text, new RegExp(`${HIGHLIGHT_START}Lenny${HIGHLIGHT_END}`));
  const to = byId("northwind")["kickoff"]!;
  assert.ok(["from", "to", "body"].includes(to.highlight.field ?? ""), "a word that only appears in addresses still marks a field");
  const flags = byId("is:starred")["invoice"]!;
  assert.equal(flags.highlight.field, null, "nothing to mark when the query had no words");
  assert.equal(flags.highlight.text, flags.excerpt);
  assert.equal(search(db, "", { now: T0 }).length, 0);
  assert.equal(search(db, "before:nope", { now: T0 }).length, 0, "a query that is only ignored tokens returns nothing");
});

test("saved searches validate and count with the same parser", () => {
  const db = seed();
  assert.throws(() => createSavedSearch(db, { name: "Nothing", query: "before:nope" }), /something to look for/);
  const row = createSavedSearch(db, { name: "Clients unread", query: "label:clients is:unread" });
  assert.equal(savedSearchCount(db, row.query), 1);
  assert.equal(savedSearchCount(db, "kickoff"), 2);
  assert.equal(savedSearchCount(db, "kickoff", ["personal"]), 0);
  assert.equal(searchCount(db, "in:inbox"), 3);
  assert.equal(searchCount(db, "in:inbox", { accountIds: ["arcforma"] }), 2);
});

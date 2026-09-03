import { test } from "node:test";
import assert from "node:assert/strict";
import { COLLAPSE_ALL_LABEL, collapsedCount, defaultExpanded, expandAllLabel, isUnread, rowSnippet } from "./collapse";

const m = (id: string, unread = false) => ({ id, labelIds: unread ? ["INBOX", "UNREAD"] : ["INBOX"] });
const thread = (n: number, unreadAt: number[] = []) => Array.from({ length: n }, (_, i) => m(`m${i + 1}`, unreadAt.includes(i)));

test("a long thread opens with the newest message, the first one, and anything unread; the rest are rows", () => {
  const t = thread(34);
  assert.deepEqual(defaultExpanded(t), ["m1", "m34"]);
  assert.equal(collapsedCount(t), 32, "the 34 message thread the brief describes folds 32 of them");
  assert.equal(expandAllLabel(collapsedCount(t)), "Show all 32 earlier messages");
});

test("an unread message in the middle of the history opens with the thread", () => {
  const t = thread(6, [3]);
  assert.deepEqual(defaultExpanded(t), ["m1", "m4", "m6"]);
  assert.equal(collapsedCount(t), 3);
  assert.ok(isUnread(t[3]!));
  assert.ok(!isUnread(t[2]!));
});

test("short threads fold nothing: one, two, and three messages are all open", () => {
  assert.deepEqual(defaultExpanded(thread(1)), ["m1"]);
  assert.equal(collapsedCount(thread(1)), 0);
  assert.deepEqual(defaultExpanded(thread(2)), ["m1", "m2"]);
  assert.equal(collapsedCount(thread(2)), 0);
  assert.equal(collapsedCount(thread(3)), 1, "the middle one of three is the first that folds");
  assert.equal(expandAllLabel(1), "Show all 1 earlier message", "one message, singular");
  assert.equal(COLLAPSE_ALL_LABEL, "Collapse earlier messages");
});

test("the row snippet flattens whitespace and cuts at a word boundary near ninety characters", () => {
  assert.equal(rowSnippet("  Kickoff \n next   week  "), "Kickoff next week");
  const long = "Thanks for sending the plan over. I have read it twice now and I think the second session should come first, before we talk about pricing.";
  const cut = rowSnippet(long);
  assert.ok(cut.length <= 91, `snippet is ${cut.length} characters`);
  assert.ok(cut.endsWith("…"));
  assert.ok(long.startsWith(cut.slice(0, -1).trimEnd()), "the cut is the start of the message, verbatim");
  assert.equal(rowSnippet(""), "");
});

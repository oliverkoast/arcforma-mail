import { test } from "node:test";
import assert from "node:assert/strict";
import { filterSnippets, findTrigger } from "./snippets";

const snippets = [
  { id: 1, trigger: "thanks", name: "Thanks and next step", bodyHtml: "<p>Thanks.</p>", bodyText: "Thanks." },
  { id: 2, trigger: "book", name: "Booking link", bodyHtml: "<p>Book here.</p>", bodyText: "Book here." },
];

test("findTrigger matches ;trigger at the end of the text before the cursor", () => {
  assert.equal(findTrigger("Hi Dana, ;thanks", snippets)!.snippet.trigger, "thanks");
  assert.equal(findTrigger("Hi Dana, ;thanks", snippets)!.length, 7);
  assert.equal(findTrigger(";book", snippets)!.snippet.trigger, "book", "start of block counts");
  assert.equal(findTrigger(";BOOK", snippets)!.snippet.trigger, "book", "case does not matter");
  assert.equal(findTrigger("see;book", snippets), null, "a semicolon inside a word is not a trigger");
  assert.equal(findTrigger("Hi ;nothere", snippets), null);
  assert.equal(findTrigger("Hi ;thanks and more", snippets), null, "only right before the cursor");
  assert.equal(findTrigger("", snippets), null);
});

test("filterSnippets searches trigger and name", () => {
  assert.deepEqual(filterSnippets("", snippets).map((s) => s.id), [1, 2]);
  assert.deepEqual(filterSnippets("bo", snippets).map((s) => s.id), [2]);
  assert.deepEqual(filterSnippets(";THANK", snippets).map((s) => s.id), [1]);
  assert.deepEqual(filterSnippets("next step", snippets).map((s) => s.id), [1]);
  assert.deepEqual(filterSnippets("zzz", snippets), []);
});

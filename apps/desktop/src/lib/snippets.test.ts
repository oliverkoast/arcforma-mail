import { test } from "node:test";
import assert from "node:assert/strict";
import { CURSOR_TOKEN, companyFromDomain, expandSnippet, filterSnippets, findTrigger, formatLongDate, missingVariablesText, nextMonday, resolveVariable, splitName, stripCursorToken, type SnippetContext } from "./snippets";

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

// ---- variables ------------------------------------------------------------------

// Tuesday, September 1, 2026, 10:00 local.
const NOW = new Date(2026, 8, 1, 10, 0, 0);
const dana: SnippetContext = { recipient: { email: "dana@northwind-coaching.example", name: "Dana Reyes" }, account: { email: "you@example.com", displayName: "Oliver Korzen" }, now: NOW };

test("recipient variables come from the first To recipient", () => {
  assert.equal(resolveVariable("first_name", dana), "Dana");
  assert.equal(resolveVariable("last_name", dana), "Reyes");
  assert.equal(resolveVariable("name", dana), "Dana Reyes");
  assert.equal(resolveVariable("email", dana), "dana@northwind-coaching.example");
  assert.equal(resolveVariable("company", dana), "Northwind Coaching", "the domain, capitalised");
  assert.equal(resolveVariable("company", { ...dana, company: "Northwind Coaching Ltd" }), "Northwind Coaching Ltd", "a stored company wins");
  const bare: SnippetContext = { ...dana, recipient: { email: "sam.okafor@gmail.com", name: "" } };
  assert.equal(resolveVariable("first_name", bare), "Sam", "no display name: the address gives a name");
  assert.equal(resolveVariable("last_name", bare), "Okafor");
  assert.equal(resolveVariable("name", bare), "Sam Okafor");
  assert.equal(resolveVariable("company", bare), null, "a mail provider is not a company");
  const single: SnippetContext = { ...dana, recipient: { email: "priya@northwind.example", name: "Priya" } };
  assert.equal(resolveVariable("first_name", single), "Priya");
  assert.equal(resolveVariable("last_name", single), null, "one word, no last name");
});

test("account variables come from the sending account", () => {
  assert.equal(resolveVariable("my_name", dana), "Oliver Korzen");
  assert.equal(resolveVariable("my_first_name", dana), "Oliver");
  const nameless: SnippetContext = { ...dana, account: { email: "you@example.net", displayName: null } };
  assert.equal(resolveVariable("my_name", nameless), null);
  assert.equal(resolveVariable("my_first_name", nameless), null);
  assert.equal(resolveVariable("my_name", { ...dana, account: null }), null);
});

test("date variables read the local calendar in long form", () => {
  assert.equal(resolveVariable("today", dana), "Tuesday, September 1");
  assert.equal(resolveVariable("tomorrow", dana), "Wednesday, September 2");
  assert.equal(resolveVariable("next_monday", dana), "Monday, September 7");
  assert.equal(formatLongDate(new Date(2026, 8, 8)), "Tuesday, September 8");
  assert.equal(formatLongDate(nextMonday(new Date(2026, 8, 7))), "Monday, September 14", "on a Monday, next Monday is next week's");
  assert.equal(formatLongDate(nextMonday(new Date(2026, 8, 6))), "Monday, September 7", "on a Sunday it is tomorrow");
  assert.equal(resolveVariable("tomorrow", { ...dana, now: new Date(2026, 11, 31) }), "Friday, January 1", "rolls over the year");
});

test("{cursor} becomes the caret token and unknown variables stay as typed", () => {
  assert.equal(resolveVariable("cursor", dana), CURSOR_TOKEN);
  assert.equal(resolveVariable("nonsense", dana), undefined);
  const r = expandSnippet({ bodyHtml: "<p>Hi {first_name}, {cursor} see {whatever}.</p>", bodyText: "Hi {first_name}, {cursor} see {whatever}." }, dana);
  assert.equal(r.html, `<p>Hi Dana, ${CURSOR_TOKEN} see {whatever}.</p>`);
  assert.equal(r.text, `Hi Dana, ${CURSOR_TOKEN} see {whatever}.`);
  assert.equal(r.hasCursor, true);
  assert.deepEqual(r.missing, []);
  assert.equal(stripCursorToken(r.html), "<p>Hi Dana,  see {whatever}.</p>");
  assert.equal(expandSnippet({ bodyHtml: "<p>plain</p>", bodyText: "plain" }, dana).hasCursor, false);
});

test("expandSnippet fills html and text bodies and escapes values into the html", () => {
  const ctx: SnippetContext = { ...dana, recipient: { email: "x@a-b.example", name: 'Ada "A&B" <Lovelace>' } };
  const r = expandSnippet({ bodyHtml: "<p>Dear {name} of {company},</p><p>{my_first_name}, {today}</p>", bodyText: "Dear {name} of {company},\n{my_first_name}, {today}" }, ctx);
  assert.equal(r.html, "<p>Dear Ada &quot;A&amp;B&quot; &lt;Lovelace&gt; of A B,</p><p>Oliver, Tuesday, September 1</p>");
  assert.equal(r.text, 'Dear Ada "A&B" <Lovelace> of A B,\nOliver, Tuesday, September 1');
  assert.deepEqual(r.missing, []);
});

test("no recipient yet: name variables become empty and are reported for a toast", () => {
  const empty: SnippetContext = { recipient: null, account: { email: "you@example.com", displayName: "" }, now: NOW };
  const r = expandSnippet({ bodyHtml: "<p>Hi {first_name} at {company}, from {my_name}. {today}</p>", bodyText: "Hi {first_name} at {company}, from {my_name}. {today}" }, empty);
  assert.equal(r.html, "<p>Hi  at , from . Tuesday, September 1</p>");
  assert.deepEqual(r.missing, ["first_name", "company", "my_name"]);
  assert.equal(missingVariablesText(r.missing), "Add a recipient to fill {first_name}, {company}, {my_name}.");
  assert.equal(missingVariablesText(["my_name"]), "Nothing to fill {my_name} with.");
  assert.equal(missingVariablesText([]), null);
  const dup = expandSnippet({ bodyHtml: "{name} {name}", bodyText: "{name}" }, empty);
  assert.deepEqual(dup.missing, ["name"], "each variable is reported once");
});

test("companyFromDomain and splitName edge cases", () => {
  assert.equal(companyFromDomain("a@northwind.co.uk"), "Northwind");
  assert.equal(companyFromDomain("a@mail.arcforma.ai"), "Arcforma");
  assert.equal(companyFromDomain("a@outlook.com"), null);
  assert.equal(companyFromDomain("a@localhost"), null);
  assert.equal(companyFromDomain("nope"), null);
  assert.deepEqual(splitName({ email: "x@y.example", name: '"Dana Reyes"' }), { first: "Dana", last: "Reyes", full: "Dana Reyes" });
  assert.deepEqual(splitName({ email: "info2024@y.example", name: "" }), { first: "Info2024", last: "", full: "Info2024" });
  assert.deepEqual(splitName({ email: "dana_m_reyes@y.example", name: "" }), { first: "Dana", last: "Reyes", full: "Dana M Reyes" });
});

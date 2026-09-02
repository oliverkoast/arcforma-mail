import { test } from "node:test";
import assert from "node:assert/strict";
import { EYEBROW_CHARS, attentionEyebrow } from "./format";

test("the list row's reason eyebrow is one line, and the whole sentence stays for the hover", () => {
  assert.equal(attentionEyebrow("Sam asked a question, you have not replied in 4 days, and you have written to them 11 times"), "Sam asked a question");
  assert.equal(attentionEyebrow("Mika asked you for something, you have not replied in 1 day, and this is their first mail to you"), "Mika asked you for something");
  assert.equal(attentionEyebrow("Bartholomew asked you for something, you have not replied"), "Bartholomew asked you for", "a long clause is cut at a word boundary, never mid-word");
  for (const reason of ["Sam asked a question, you have not replied", "Bartholomew asked you for something, you have not replied", "Konstantinopolous named a date, you have not replied in 30 days"]) {
    assert.ok((attentionEyebrow(reason) ?? "").length <= EYEBROW_CHARS, `${reason} fits on one line`);
  }
  assert.equal(attentionEyebrow(null), null);
  assert.equal(attentionEyebrow(""), null);
  assert.equal(attentionEyebrow("   "), null);
  assert.equal(attentionEyebrow("No comma anywhere"), "No comma anywhere");
});

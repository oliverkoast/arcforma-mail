import { test } from "node:test";
import assert from "node:assert/strict";
import { HIGHLIGHT_END, HIGHLIGHT_START } from "../../shared/types";
import { highlightFieldLabel, splitHighlight, stripMarkers } from "./highlight";

const S = HIGHLIGHT_START;
const E = HIGHLIGHT_END;

test("the renderer's markers are the store's markers", async () => {
  const store = await import("@arcforma/store");
  assert.equal(S, store.HIGHLIGHT_START);
  assert.equal(E, store.HIGHLIGHT_END);
});

test("splitHighlight turns marker runs into marked and plain pieces", () => {
  assert.deepEqual(splitHighlight(`Re: ${S}Kickoff${E} next ${S}week${E}`), [
    { text: "Re: ", mark: false },
    { text: "Kickoff", mark: true },
    { text: " next ", mark: false },
    { text: "week", mark: true },
  ]);
  assert.deepEqual(splitHighlight("no marks"), [{ text: "no marks", mark: false }]);
  assert.deepEqual(splitHighlight(""), []);
  assert.deepEqual(splitHighlight(`${S}${E}x`), [{ text: "x", mark: false }], "an empty run is dropped");
});

test("unbalanced markers never hide words", () => {
  assert.deepEqual(splitHighlight(`a ${S}b c`), [{ text: "a b c", mark: false }]);
  assert.deepEqual(splitHighlight(`a b${E} c`), [{ text: "a b c", mark: false }]);
  assert.equal(stripMarkers(`${S}a${E}${S}`), "a");
});

test("field labels", () => {
  assert.equal(highlightFieldLabel("subject"), "IN SUBJECT");
  assert.equal(highlightFieldLabel("from"), "FROM");
  assert.equal(highlightFieldLabel("to"), "TO");
  assert.equal(highlightFieldLabel("body"), "IN MESSAGE");
  assert.equal(highlightFieldLabel(null), "");
});

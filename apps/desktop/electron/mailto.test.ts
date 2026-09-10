import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMailto } from "./mailto.js";

test("a mailto link becomes a compose: addresses, subject, body as escaped paragraphs", () => {
  assert.deepEqual(parseMailto("mailto:editor@example.com"), { to: [{ email: "editor@example.com", name: "" }], subject: "", bodyHtml: "" });
  const r = parseMailto("mailto:a@example.com,b@example.com?subject=Product%20Weekly&body=Line%20one%0ALine%20%3Ctwo%3E");
  assert.deepEqual(r?.to.map((a: { email: string }) => a.email), ["a@example.com", "b@example.com"]);
  assert.equal(r?.subject, "Product Weekly");
  assert.equal(r?.bodyHtml, "<p>Line one</p><p>Line &lt;two&gt;</p>", "a body is text, never markup");
  assert.equal(parseMailto("mailto:?subject=nobody"), null, "no address, no compose");
  assert.equal(parseMailto("https://example.com"), null);
});

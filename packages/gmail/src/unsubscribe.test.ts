import { test } from "node:test";
import assert from "node:assert/strict";
import { ONE_CLICK_BODY, bestUnsubscribeMethod, buildUnsubscribeMessage, listUnsubscribeEntries, parseListUnsubscribe, parseMailto, postOneClick } from "./unsubscribe.js";
import type { Transport, TransportInit } from "./transport.js";

test("parseListUnsubscribe: one-click when the Post header says so and the target is https", () => {
  const t = parseListUnsubscribe("<https://news.example/u?id=abc>, <mailto:unsub@news.example?subject=stop>", "List-Unsubscribe=One-Click");
  assert.equal(t.oneClick, "https://news.example/u?id=abc");
  assert.equal(t.url, "https://news.example/u?id=abc");
  assert.deepEqual(t.mailto, { to: "unsub@news.example", subject: "stop", body: "" });
  assert.equal(bestUnsubscribeMethod(t), "one-click");
  // The Post header is case-insensitive but must be the RFC body, not anything else.
  assert.equal(parseListUnsubscribe("<https://x.example/u>", "list-unsubscribe=one-click").oneClick, "https://x.example/u");
  assert.equal(parseListUnsubscribe("<https://x.example/u>", "List-Unsubscribe=Later").oneClick, null);
  assert.equal(parseListUnsubscribe("<http://x.example/u>", "List-Unsubscribe=One-Click").oneClick, null, "plain http is never one-click");
});

test("parseListUnsubscribe: mailto alone builds a message target; the subject defaults to unsubscribe", () => {
  const t = parseListUnsubscribe("<mailto:leave@list.example?body=please%20remove%20me>");
  assert.equal(t.oneClick, null);
  assert.equal(t.url, null);
  assert.deepEqual(t.mailto, { to: "leave@list.example", subject: "unsubscribe", body: "please remove me" });
  assert.equal(bestUnsubscribeMethod(t), "mailto");
  assert.deepEqual(parseMailto("mailto:a@b.example?Subject=Unsubscribe+now&Body=bye"), { to: "a@b.example", subject: "Unsubscribe now", body: "bye" });
  assert.equal(parseMailto("mailto:not-an-address"), null);
  assert.equal(parseMailto("https://x.example"), null);
});

test("parseListUnsubscribe: a URL without the Post header is opened, https preferred over http; bare entries parse too", () => {
  const t = parseListUnsubscribe("<http://news.example/u>, <https://news.example/u>");
  assert.equal(t.oneClick, null);
  assert.equal(t.url, "https://news.example/u");
  assert.equal(bestUnsubscribeMethod(t), "open");
  assert.deepEqual(listUnsubscribeEntries("https://a.example/u, mailto:b@c.example"), ["https://a.example/u", "mailto:b@c.example"]);
  assert.equal(bestUnsubscribeMethod(parseListUnsubscribe("<ftp://nope.example>")), null);
  assert.equal(bestUnsubscribeMethod(parseListUnsubscribe("")), null);
});

test("postOneClick POSTs the RFC 8058 body as a form and fails on anything but 2xx", async () => {
  const calls: Array<{ url: string; init: TransportInit }> = [];
  let status = 200;
  const transport: Transport = async (url, init) => {
    calls.push({ url, init });
    return { status, headers: { get: () => null }, text: async () => "" };
  };
  await postOneClick("https://news.example/u?id=abc", transport);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://news.example/u?id=abc");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.body, ONE_CLICK_BODY);
  assert.equal(calls[0]!.init.headers?.["Content-Type"], "application/x-www-form-urlencoded");
  status = 500;
  await assert.rejects(postOneClick("https://news.example/u", transport), /HTTP 500/);
  await assert.rejects(postOneClick("http://news.example/u", transport), /https/);
  assert.equal(calls.length, 2, "the http URL was refused before any request");
});

test("buildUnsubscribeMessage: the mailto target becomes a plain message with no signature", async () => {
  const built = await buildUnsubscribeMessage({ email: "you@example.com", name: "Oliver Korzen" }, { to: "unsub@news.example", subject: "unsubscribe", body: "" });
  assert.match(built.mime, /^To: unsub@news.example/m);
  assert.match(built.mime, /^Subject: unsubscribe/m);
  assert.match(built.mime, /^From: "?Oliver Korzen"? <you@example.com>/m);
  assert.equal(/gmail_signature/.test(built.mime), false);
  assert.equal(/gmail_quote/.test(built.mime), false);
  const decoded = Buffer.from(built.raw, "base64url").toString("utf8");
  assert.equal(decoded, built.mime);
});

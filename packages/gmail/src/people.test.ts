import { test } from "node:test";
import assert from "node:assert/strict";
import { gravatarHash, gravatarUrl, lookupPerson, resolvePhoto } from "./people.js";
import { fakeTransport, token } from "../test/helpers.js";

test("gravatar hash is the md5 of the trimmed, lowercased address", () => {
  assert.equal(gravatarHash("  Dana@Northwind.Example "), gravatarHash("dana@northwind.example"));
  assert.equal(gravatarHash("MyEmailAddress@example.com"), "0bc83cb571cd1c50ba6f3e8a78ef1346");
  assert.match(gravatarUrl("dana@northwind.example"), /^https:\/\/www\.gravatar\.com\/avatar\/[0-9a-f]{32}\?d=404&s=160$/);
});

test("People API photo wins when contacts.readonly is granted and a non-default photo exists", async () => {
  const { transport, calls } = fakeTransport([
    {
      status: 200,
      body: { results: [{ person: { names: [{ displayName: "Dana Reyes" }], photos: [{ url: "https://lh3.example/default", default: true }, { url: "https://lh3.example/dana.jpg" }] } }] },
    },
  ]);
  const r = await resolvePhoto("dana@northwind.example", { accessToken: token, transport });
  assert.deepEqual(r, { source: "people", photoUrl: "https://lh3.example/dana.jpg", name: "Dana Reyes" });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /people:searchContacts\?query=dana%40northwind\.example&readMask=names,photos/);
  assert.equal(calls[0]!.init.headers?.["Authorization"], "Bearer test-token");
});

test("a 403 from People (scope not granted) falls through to Gravatar", async () => {
  const { transport, calls } = fakeTransport([
    { status: 403, body: { error: { message: "Request had insufficient authentication scopes." } } },
    { status: 403, body: { error: { message: "Request had insufficient authentication scopes." } } },
    { status: 200, text: "" },
  ]);
  const r = await resolvePhoto("dana@northwind.example", { accessToken: token, transport });
  assert.equal(r.source, "gravatar");
  assert.equal(r.photoUrl, gravatarUrl("dana@northwind.example"));
  assert.equal(calls.length, 3);
  assert.match(calls[1]!.url, /otherContacts:search/);
  assert.equal(calls[2]!.init.method, "HEAD");
});

test("no People match and a 404 from Gravatar ends in initials, keeping any name People returned", async () => {
  const { transport } = fakeTransport([
    { status: 200, body: { results: [{ person: { names: [{ displayName: "Dana Reyes" }], photos: [{ url: "https://lh3.example/default", default: true }] } }] } },
    { status: 200, body: { results: [] } },
    { status: 404, text: "" },
  ]);
  const r = await resolvePhoto("dana@northwind.example", { accessToken: token, transport });
  assert.deepEqual(r, { source: "none", photoUrl: null, name: "Dana Reyes" });
});

test("without a token the People hop is skipped entirely and a transport failure never throws", async () => {
  const { transport, calls } = fakeTransport(() => {
    throw new Error("offline");
  });
  const r = await resolvePhoto("dana@northwind.example", { transport });
  assert.deepEqual(r, { source: "none", photoUrl: null, name: null });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /gravatar/);
});

test("lookupPerson raises on a server error so the caller can decide", async () => {
  const { transport } = fakeTransport([{ status: 500, text: "boom" }]);
  await assert.rejects(lookupPerson("x@y.example", { accessToken: token, transport }), /People API 500/);
});

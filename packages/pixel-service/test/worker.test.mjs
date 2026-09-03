import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../src/worker.mjs";

const TOKEN = "a".repeat(32);
const AUTH = "s".repeat(40);

function memoryStore(sentAt = 1000) {
  const events = new Map();
  const sent = new Map([[TOKEN, sentAt]]);
  return {
    events,
    async sentAt(t) { return sent.has(t) ? sent.get(t) : null; },
    async register(t, at) { sent.set(t, at); },
    async events(t) { return events.get(t) ?? []; },
    async record(t, e) { events.set(t, [...(events.get(t) ?? []), e]); },
    async since(ts) { return [...events.entries()].flatMap(([token, list]) => list.filter((e) => e.at > ts).map((e) => ({ token, ...e }))); },
  };
}
const get = (path, headers = {}) => new Request(`https://example.test${path}`, { headers });

test("the pixel is always a valid GIF, is never cached, and records the fetch", async () => {
  const store = memoryStore();
  const handle = createHandler({ store, authToken: AUTH, now: () => 100_000 });
  const res = await handle(get(`/p/${TOKEN}.gif`, { "user-agent": "Mozilla/5.0 GoogleImageProxy" }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/gif");
  assert.match(res.headers.get("cache-control"), /no-store/);
  const body = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...body.slice(0, 6)], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], "GIF89a header");
  assert.equal((await store.events(TOKEN)).length, 1);
  assert.equal((await store.events(TOKEN))[0].grade, "opened");
});

test("an unknown token still returns a working image and records nothing", async () => {
  const store = memoryStore();
  const handle = createHandler({ store, authToken: AUTH });
  const res = await handle(get(`/p/${"b".repeat(32)}.gif`));
  assert.equal(res.status, 200);
  assert.equal((await store.events("b".repeat(32))).length, 0);
});

test("a storage failure never breaks the recipient's message", async () => {
  const store = { ...memoryStore(), sentAt: async () => { throw new Error("kv down"); } };
  const res = await createHandler({ store, authToken: AUTH })(get(`/p/${TOKEN}.gif`));
  assert.equal(res.status, 200);
});

test("no IP address or recipient is ever stored, only the token, time, grade and user agent", async () => {
  const store = memoryStore();
  await createHandler({ store, authToken: AUTH, now: () => 100_000 })(
    get(`/p/${TOKEN}.gif`, { "user-agent": "Mozilla/5.0", "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.9" })
  );
  const [event] = await store.events(TOKEN);
  assert.deepEqual(Object.keys(event).sort(), ["at", "grade", "userAgent", "why"]);
  assert.ok(!JSON.stringify(event).includes("203.0.113.9"));
});

test("reading events needs the bearer token and rejects a wrong one", async () => {
  const handle = createHandler({ store: memoryStore(), authToken: AUTH });
  assert.equal((await handle(get("/events"))).status, 401);
  assert.equal((await handle(get("/events", { authorization: `Bearer ${"x".repeat(40)}` }))).status, 401);
  assert.equal((await handle(get("/events", { authorization: `Bearer ${AUTH}` }))).status, 200);
});

test("a token is capped so one recipient cannot fill the store", async () => {
  const store = memoryStore();
  const handle = createHandler({ store, authToken: AUTH, now: () => 100_000 });
  for (let i = 0; i < 60; i++) await handle(get(`/p/${TOKEN}.gif`, { "user-agent": "Mozilla/5.0" }));
  assert.equal((await store.events(TOKEN)).length, 50);
});

test("anything else is a 404", async () => {
  const handle = createHandler({ store: memoryStore(), authToken: AUTH });
  assert.equal((await handle(get("/"))).status, 404);
  assert.equal((await handle(get("/p/../../etc/passwd"))).status, 404);
});

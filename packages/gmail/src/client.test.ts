import { test } from "node:test";
import assert from "node:assert/strict";
import { GmailClient, TokenBucket, buildBatchBody, parseBatchResponse, quotaFor } from "./client.js";
import { GmailApiError } from "./errors.js";
import { fakeClock, fakeTransport, fixture, token } from "../test/helpers.js";

test("token bucket allows a burst up to capacity then paces at the refill rate", () => {
  const clock = fakeClock();
  const bucket = new TokenBucket(200, 200, clock.now);
  assert.equal(bucket.take(200), 0);
  assert.equal(bucket.take(100), 500, "100 units over means a 500 ms wait at 200 units/s");
  clock.advance(500);
  assert.equal(bucket.take(0), 0);
  clock.advance(1000);
  assert.equal(bucket.take(200), 0, "a full second refills to capacity");
});

test("quota cost table maps paths to units", () => {
  assert.equal(quotaFor("GET", "threads/abc?format=metadata"), 10);
  assert.equal(quotaFor("GET", "threads"), 10);
  assert.equal(quotaFor("GET", "messages/abc"), 5);
  assert.equal(quotaFor("POST", "messages/send"), 100);
  assert.equal(quotaFor("POST", "threads/abc/modify"), 10);
  assert.equal(quotaFor("GET", "history"), 2);
  assert.equal(quotaFor("GET", "profile"), 1);
  assert.equal(quotaFor("POST", "labels"), 5);
});

test("request backs off on 429 honouring Retry-After and on 403 rateLimitExceeded", async () => {
  const clock = fakeClock();
  const { transport, calls } = fakeTransport([
    { status: 429, body: { error: { message: "slow down", errors: [{ reason: "rateLimitExceeded" }] } }, headers: { "Retry-After": "2" } },
    { status: 403, body: { error: { message: "user rate", errors: [{ reason: "userRateLimitExceeded" }] } } },
    { status: 200, body: { emailAddress: "you@example.com", historyId: "1" } },
  ]);
  const retries: number[] = [];
  const client = new GmailClient({ accessToken: token, transport, sleep: clock.sleep, now: clock.now, onRetry: (i) => retries.push(i.status) });
  const profile = await client.request<{ emailAddress: string }>("profile");
  assert.equal(profile.emailAddress, "you@example.com");
  assert.equal(calls.length, 3);
  assert.equal(clock.sleeps[0], 2000, "Retry-After seconds become the wait");
  assert.ok(clock.sleeps[1]! >= 2000 && clock.sleeps[1]! < 2300, "second retry uses exponential backoff");
  assert.deepEqual(retries, [429, 403]);
  assert.equal(calls[0]!.init.headers?.["Authorization"], "Bearer test-token");
});

test("request refreshes the token once on 401 and throws typed errors otherwise", async () => {
  const forced: boolean[] = [];
  const { transport } = fakeTransport([
    { status: 401, body: { error: { message: "expired", status: "UNAUTHENTICATED" } } },
    { status: 200, body: { ok: true } },
    { status: 400, body: { error: { message: "bad request", errors: [{ reason: "invalidArgument" }] } } },
  ]);
  const client = new GmailClient({
    accessToken: async (force) => {
      forced.push(Boolean(force));
      return "t";
    },
    transport,
    sleep: async () => {},
  });
  assert.deepEqual(await client.request("profile"), { ok: true });
  assert.deepEqual(forced, [false, true]);
  await assert.rejects(client.request("profile"), (err: unknown) => err instanceof GmailApiError && err.status === 400 && err.reason === "invalidArgument");
});

test("batch body has one application/http part per request", () => {
  const body = buildBatchBody("b1", [
    { id: "item0", req: { path: "threads/a", query: { format: "metadata", metadataHeaders: ["From", "To"] } } },
    { id: "item1", req: { method: "POST", path: "threads/b/modify", body: { addLabelIds: ["STARRED"] } } },
  ]);
  assert.equal((body.match(/Content-Type: application\/http/g) ?? []).length, 2);
  assert.match(body, /GET \/gmail\/v1\/users\/me\/threads\/a\?format=metadata&metadataHeaders=From&metadataHeaders=To HTTP\/1\.1/);
  assert.match(body, /POST \/gmail\/v1\/users\/me\/threads\/b\/modify HTTP\/1\.1\r\nContent-Type: application\/json/);
  assert.match(body, /\{"addLabelIds":\["STARRED"\]\}/);
  assert.ok(body.endsWith("--b1--\r\n"));
});

test("batch response parsing keeps statuses, headers, and bodies per Content-ID", () => {
  const parts = parseBatchResponse("multipart/mixed; boundary=batch_abc123", fixture("batch-response.txt"));
  assert.deepEqual([...parts.keys()], ["item0", "item1", "item2"]);
  assert.equal(parts.get("item0")!.status, 200);
  assert.equal((JSON.parse(parts.get("item0")!.body) as { id: string }).id, "t1");
  assert.equal(parts.get("item1")!.status, 404);
  assert.equal(parts.get("item2")!.status, 429);
  assert.equal(parts.get("item2")!.headers["retry-after"], "3");
});

test("batch retries only the rate-limited parts and aligns results with input order", async () => {
  const clock = fakeClock();
  const second = [
    "--batch_two",
    "Content-Type: application/http",
    "Content-ID: <response-item2>",
    "",
    "HTTP/1.1 200 OK",
    "Content-Type: application/json",
    "",
    '{"id":"t3"}',
    "--batch_two--",
    "",
  ].join("\r\n");
  const { transport, calls } = fakeTransport([
    { status: 200, text: fixture("batch-response.txt"), headers: { "Content-Type": "multipart/mixed; boundary=batch_abc123" } },
    { status: 200, text: second, headers: { "Content-Type": "multipart/mixed; boundary=batch_two" } },
  ]);
  const client = new GmailClient({ accessToken: token, transport, sleep: clock.sleep, now: clock.now });
  const results = await client.batch<{ id: string }>([{ path: "threads/t1" }, { path: "threads/t2" }, { path: "threads/t3" }]);
  assert.equal(calls.length, 2);
  assert.equal(results[0]!.body!.id, "t1");
  assert.equal(results[1]!.status, 404);
  assert.equal(results[1]!.error!.reason, "notFound");
  assert.equal(results[2]!.body!.id, "t3");
  assert.equal(clock.sleeps[0], 3000, "part-level Retry-After is honoured");
  assert.match(calls[1]!.init.body ?? "", /threads\/t3/);
  assert.doesNotMatch(calls[1]!.init.body ?? "", /threads\/t1/);
});

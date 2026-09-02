import { test } from "node:test";
import assert from "node:assert/strict";
import { GmailClient } from "./client.js";
import { LabelResolver, drainAccount, executeOutboxOp, retryDelayMs, type OutboxJob } from "./outbox.js";
import { fakeClock, fakeTransport, token } from "../test/helpers.js";

test("modifyLabels resolves label names, creating Arcforma/Snoozed on first use", async () => {
  const { transport, calls } = fakeTransport([
    { status: 200, body: { labels: [{ id: "INBOX", name: "INBOX", type: "system" }] } },
    { status: 200, body: { id: "Label_7", name: "Arcforma/Snoozed" } },
    { status: 200, body: { id: "t1", messages: [] } },
  ]);
  const client = new GmailClient({ accessToken: token, transport, sleep: async () => {} });
  const labels = new LabelResolver(client);
  const job: OutboxJob = { id: 1, op: "modifyLabels", attempts: 0, payload: { threadId: "t1", removeLabelIds: ["INBOX"], addLabelNames: ["Arcforma/Snoozed"] } };
  const outcome = await executeOutboxOp(client, labels, job);
  assert.equal(outcome.ok, true);
  assert.match(calls[1]!.url, /labels$/);
  assert.equal(JSON.parse(calls[1]!.init.body!).name, "Arcforma/Snoozed");
  assert.match(calls[2]!.url, /threads\/t1\/modify$/);
  assert.deepEqual(JSON.parse(calls[2]!.init.body!), { addLabelIds: ["Label_7"], removeLabelIds: ["INBOX"] });
});

test("drain is serial, acks in order, and stops at a retrying row", async () => {
  const clock = fakeClock();
  const { transport } = fakeTransport((call) => {
    if (/t2\/trash/.test(call.url)) return { status: 503, body: { error: { message: "backend" } } };
    return { status: 200, body: {} };
  });
  const client = new GmailClient({ accessToken: token, transport, sleep: clock.sleep, now: clock.now, maxAttempts: 1 });
  const jobs: OutboxJob[] = [
    { id: 1, op: "modifyLabels", attempts: 0, payload: { threadId: "t1", addLabelIds: ["STARRED"] } },
    { id: 2, op: "trash", attempts: 0, payload: { threadId: "t2" } },
    { id: 3, op: "modifyLabels", attempts: 0, payload: { threadId: "t3", addLabelIds: ["STARRED"] } },
  ];
  const events: string[] = [];
  const result = await drainAccount(client, new LabelResolver(client), {
    next: () => jobs.shift() ?? null,
    markInflight: (id) => events.push(`inflight ${id}`),
    ack: (id) => events.push(`ack ${id}`),
    fail: (id, _err, retryAt) => events.push(`fail ${id} ${retryAt === null ? "terminal" : "retry"}`),
  }, { now: clock.now });
  assert.deepEqual(events, ["inflight 1", "ack 1", "inflight 2", "fail 2 retry"]);
  assert.deepEqual(result, { done: 1, failed: 1 });
  assert.equal(jobs.length, 1, "the third job waits for the retry so order holds");
  assert.equal(retryDelayMs(1), 2000);
  assert.equal(retryDelayMs(2), 8000);
  assert.equal(retryDelayMs(9), 300_000);
});

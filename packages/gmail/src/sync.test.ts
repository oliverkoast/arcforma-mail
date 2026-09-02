import { test } from "node:test";
import assert from "node:assert/strict";
import { GmailClient } from "./client.js";
import { GmailApiError } from "./errors.js";
import { backfill, fetchThreadsMetadata } from "./sync.js";
import { fakeTransport, token, type Canned } from "../test/helpers.js";

/** A multipart/mixed batch response with one part per (id, status, body). */
function batchResponse(parts: Array<{ id: string; status: number; body: unknown }>): Canned {
  const boundary = "batch_test";
  const text = parts
    .map(
      (p) =>
        `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <response-${p.id}>\r\n\r\nHTTP/1.1 ${p.status} X\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(p.body)}\r\n`
    )
    .join("");
  return { status: 200, text: `${text}--${boundary}--\r\n`, headers: { "content-type": `multipart/mixed; boundary=${boundary}` } };
}

const thread = (id: string) => ({ id, historyId: "10", messages: [{ id: `${id}-m1`, threadId: id, labelIds: ["INBOX"] }] });

test("fetchThreadsMetadata skips a vanished thread but fails the page on any other part error", async () => {
  const { transport } = fakeTransport([
    batchResponse([
      { id: "item0", status: 200, body: thread("t1") },
      { id: "item1", status: 404, body: { error: { message: "gone" } } },
    ]),
    batchResponse([
      { id: "item0", status: 200, body: thread("t1") },
      { id: "item1", status: 500, body: { error: { message: "backend" } } },
    ]),
  ]);
  const client = new GmailClient({ accessToken: token, transport, sleep: async () => {}, maxAttempts: 1 });
  const ok = await fetchThreadsMetadata(client, ["t1", "t2"]);
  assert.deepEqual(ok.map((t) => t.id), ["t1"], "a 404 is a thread that vanished between list and get");
  await assert.rejects(fetchThreadsMetadata(client, ["t1", "t2"]), (err: unknown) => err instanceof GmailApiError && err.status === 500, "a 500 past the retry budget must not be dropped silently");
});

test("backfill records the watermark before listing, persists the cursor only after a page is applied, and resumes without re-reading the profile", async () => {
  const { transport, calls } = fakeTransport((call) => {
    if (/\/profile$/.test(call.url)) return { status: 200, body: { emailAddress: "you@example.com", historyId: "777" } };
    if (/\/threads\?/.test(call.url)) {
      if (/pageToken=p2/.test(call.url)) return { status: 200, body: { threads: [{ id: "t3" }], resultSizeEstimate: 3 } };
      return { status: 200, body: { threads: [{ id: "t1" }, { id: "t2" }], nextPageToken: "p2", resultSizeEstimate: 3 } };
    }
    if (/batch/.test(call.url)) {
      const ids = [...call.init.body!.matchAll(/threads\/(t\d)/g)].map((m) => m[1]!);
      if (ids.includes("t3") && calls.filter((c) => /batch/.test(c.url)).length === 2) return { status: 503, body: { error: { message: "backend" } } };
      return batchResponse(ids.map((id, i) => ({ id: `item${i}`, status: 200, body: thread(id) })));
    }
    throw new Error(`unexpected ${call.url}`);
  });
  const client = new GmailClient({ accessToken: token, transport, sleep: async () => {}, maxAttempts: 1 });
  const events: string[] = [];
  const sink = {
    onHistoryId: (h: string) => events.push(`historyId ${h}`),
    onThreads: (ts: Array<{ id: string }>) => events.push(`threads ${ts.map((t) => t.id).join(",")}`),
    onCursor: (c: string | null) => events.push(`cursor ${c}`),
  };
  // Page 2's batch fails: the run stops with the cursor still pointing at page 2.
  await assert.rejects(backfill({ client, pageSize: 2 }, sink));
  assert.deepEqual(events, ["historyId 777", "threads t1,t2", "cursor p2"], "the watermark comes first, the cursor only after the page landed");
  // Resume from the persisted cursor: no profile call, page 2 lands, and the cursor clears.
  events.length = 0;
  const profileCalls = calls.filter((c) => /\/profile$/.test(c.url)).length;
  const result = await backfill({ client, pageSize: 2, cursor: "p2", doneSoFar: 2 }, sink);
  assert.deepEqual(events, ["threads t3", "cursor null"]);
  assert.equal(calls.filter((c) => /\/profile$/.test(c.url)).length, profileCalls, "a resumed backfill keeps the original watermark");
  assert.deepEqual(result, { threads: 3, finished: true });
});

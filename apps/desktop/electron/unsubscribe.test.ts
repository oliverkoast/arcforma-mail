import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Transport, TransportInit } from "@arcforma/gmail";
import { getThread, getUnsubscribeState, listOutbox, listSends, openStore, upsertAccount, upsertThreadFromGmail, type Db } from "@arcforma/store";
import { senderLabel, unsubscribeThread } from "./unsubscribe.js";

const T0 = 1_800_000_000_000;

function newsletter(db: Db, id: string, headers: Record<string, string>, from = "Lenny's Newsletter <lenny@substack.example>") {
  upsertThreadFromGmail(
    db,
    "arcforma",
    {
      id,
      historyId: "1",
      messages: [
        {
          id: `m-${id}`,
          threadId: id,
          labelIds: ["INBOX", "UNREAD"],
          snippet: "",
          internalDate: String(T0 - 1000),
          historyId: "1",
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: from },
              { name: "To", value: "you@example.com" },
              { name: "Subject", value: "This week" },
              { name: "Message-ID", value: `<m-${id}@x>` },
              ...Object.entries(headers).map(([name, value]) => ({ name, value })),
            ],
          },
        },
      ],
    },
    { ownerAddresses: ["you@example.com"] }
  );
}

function tempDb(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-unsub-"));
  const db = openStore(path.join(dir, "mail.db"));
  upsertAccount(db, { id: "arcforma", email: "you@example.com", displayName: "Oliver Korzen" });
  return db;
}

function fakeTransport(status: number) {
  const calls: Array<{ url: string; init: TransportInit }> = [];
  const transport: Transport = async (url, init) => {
    calls.push({ url, init });
    return { status, headers: { get: () => null }, text: async () => "" };
  };
  return { transport, calls };
}

test("one-click: POSTs the RFC 8058 body, records sent, archives, and names the sender", async () => {
  const db = tempDb();
  newsletter(db, "lenny", { "List-Unsubscribe": "<https://substack.example/u/abc>, <mailto:unsub@substack.example>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  const api = fakeTransport(200);
  const opened: string[] = [];
  const r = await unsubscribeThread(db, "arcforma", "lenny", { transport: api.transport, openExternal: (u) => void opened.push(u), now: T0 });
  assert.equal(r.method, "one-click");
  assert.equal(r.ok, true);
  assert.equal(r.archived, true);
  assert.equal(r.state, "sent");
  assert.equal(r.text, "Unsubscribed from Lenny's Newsletter and archived.");
  assert.equal(r.sendId, null);
  assert.deepEqual(api.calls.map((c) => [c.url, c.init.method, c.init.body]), [["https://substack.example/u/abc", "POST", "List-Unsubscribe=One-Click"]]);
  assert.deepEqual(opened, [], "no page was opened");
  assert.equal(getThread(db, "arcforma", "lenny")!.in_inbox, 0, "archived locally");
  assert.ok(listOutbox(db, "arcforma", "pending").some((o) => o.op === "modifyLabels" && JSON.parse(o.payload_json).removeLabelIds.includes("INBOX")), "and the archive is queued for Gmail");
  assert.equal(getUnsubscribeState(db, "arcforma", "lenny")!.method, "one-click");
  assert.equal(listSends(db).length, 0, "no mail was queued");
});

test("mailto: builds the request through the send queue with no signature, archives, and reports the send id", async () => {
  const db = tempDb();
  newsletter(db, "digest", { "List-Unsubscribe": "<mailto:leave@digest.example?subject=unsubscribe%20me>" }, "The Digest <hello@digest.example>");
  const api = fakeTransport(200);
  const r = await unsubscribeThread(db, "arcforma", "digest", { transport: api.transport, openExternal: () => {}, now: T0 });
  assert.equal(r.method, "mailto");
  assert.equal(r.ok, true);
  assert.equal(r.archived, true);
  assert.equal(r.text, "Unsubscribed from The Digest and archived.");
  assert.equal(api.calls.length, 0, "nothing was POSTed");
  const sends = listSends(db);
  assert.equal(sends.length, 1);
  assert.equal(r.sendId, sends[0]!.id);
  assert.equal(sends[0]!.status, "queued");
  assert.equal(sends[0]!.send_at, T0, "goes out on the next tick, no undo window");
  assert.equal(sends[0]!.thread_id, null);
  assert.match(sends[0]!.raw_mime, /^To: leave@digest.example/m);
  assert.match(sends[0]!.raw_mime, /^Subject: unsubscribe me/m);
  assert.match(sends[0]!.raw_mime, /^From: "?Oliver Korzen"? <you@example.com>/m);
  assert.equal(/gmail_signature/.test(sends[0]!.raw_mime), false);
  assert.deepEqual(JSON.parse(sends[0]!.meta_json), { unsubscribe: { threadId: "digest", to: "leave@digest.example" } });
  assert.equal(getUnsubscribeState(db, "arcforma", "digest")!.state, "sent");
});

test("a URL without the Post header opens the page and leaves the thread where it is", async () => {
  const db = tempDb();
  newsletter(db, "promo", { "List-Unsubscribe": "<https://promo.example/leave?u=1>" }, "promo@promo.example");
  const opened: string[] = [];
  const r = await unsubscribeThread(db, "arcforma", "promo", { transport: fakeTransport(200).transport, openExternal: (u) => void opened.push(u), now: T0 });
  assert.equal(r.method, "open");
  assert.equal(r.ok, true);
  assert.equal(r.archived, false);
  assert.equal(r.state, "opened");
  assert.equal(r.text, "Opened the unsubscribe page.");
  assert.deepEqual(opened, ["https://promo.example/leave?u=1"]);
  assert.equal(getThread(db, "arcforma", "promo")!.in_inbox, 1, "still in the inbox until the page is done");
  assert.equal(getUnsubscribeState(db, "arcforma", "promo")!.state, "opened");
});

test("a failed one-click falls back to the page; a thread without the header says so", async () => {
  const db = tempDb();
  newsletter(db, "flaky", { "List-Unsubscribe": "<https://flaky.example/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }, "Flaky <news@flaky.example>");
  const api = fakeTransport(503);
  const opened: string[] = [];
  const r = await unsubscribeThread(db, "arcforma", "flaky", { transport: api.transport, openExternal: (u) => void opened.push(u), now: T0 });
  assert.equal(api.calls.length, 1, "the POST was tried");
  assert.equal(r.method, "open");
  assert.equal(r.state, "opened");
  assert.deepEqual(opened, ["https://flaky.example/u"]);
  assert.equal(getThread(db, "arcforma", "flaky")!.in_inbox, 1);

  newsletter(db, "dana", {}, "Dana Reyes <dana@northwind.example>");
  const none = await unsubscribeThread(db, "arcforma", "dana", { transport: api.transport, openExternal: () => {}, now: T0 });
  assert.equal(none.method, "none");
  assert.equal(none.ok, false);
  assert.equal(none.text, "No unsubscribe link in this thread.");
  assert.equal(getUnsubscribeState(db, "arcforma", "dana"), null, "nothing is recorded when nothing ran");
  assert.equal(senderLabel({ fromName: "", fromEmail: "news@flaky.example", listId: "<weekly.flaky.example>" }), "weekly");
  assert.equal(senderLabel({ fromName: "", fromEmail: "news@flaky.example", listId: null }), "flaky.example");
});

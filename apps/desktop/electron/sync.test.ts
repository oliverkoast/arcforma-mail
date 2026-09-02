import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GmailClient, type Transport, type TransportInit } from "@arcforma/gmail";
import { archive, createSnooze, getAccount, getThread, listOutbox, listThreadMessages, openStore, saveDraft, listDrafts, updateAccount, upsertAccount, upsertThreadFromGmail, type Db } from "@arcforma/store";
import { SyncManager, type SyncAccounts } from "./sync.js";

interface Canned {
  status: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

interface Call {
  url: string;
  init: TransportInit;
}

function transportOf(handler: (call: Call) => Canned | Promise<Canned>): { transport: Transport; calls: Call[] } {
  const calls: Call[] = [];
  const transport: Transport = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    const canned = await handler(call);
    const headers = new Map(Object.entries(canned.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: canned.status, headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null }, text: async () => canned.text ?? (canned.body === undefined ? "" : JSON.stringify(canned.body)) };
  };
  return { transport, calls };
}

function batchResponse(parts: Array<{ id: string; status: number; body: unknown }>): Canned {
  const boundary = "batch_test";
  const text = parts.map((p) => `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <response-${p.id}>\r\n\r\nHTTP/1.1 ${p.status} X\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(p.body)}\r\n`).join("");
  return { status: 200, text: `${text}--${boundary}--\r\n`, headers: { "content-type": `multipart/mixed; boundary=${boundary}` } };
}

const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);

function gmailThread(id: string, messages: Array<{ id: string; labels: string[]; date?: number; from?: string }>) {
  return {
    id,
    historyId: "100",
    messages: messages.map((m) => ({
      id: m.id,
      threadId: id,
      labelIds: m.labels,
      internalDate: String(m.date ?? T0),
      historyId: "100",
      snippet: "hi",
      payload: { mimeType: "text/plain", headers: [{ name: "From", value: m.from ?? "Dana <dana@northwind.example>" }, { name: "To", value: "you@example.com" }, { name: "Subject", value: "Kickoff" }] },
    })),
  };
}

function idsInBatch(body: string | undefined): string[] {
  return [...(body ?? "").matchAll(/threads\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
}

function tempDb(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-sync-"));
  return openStore(path.join(dir, "mail.db"));
}

function liveAccount(db: Db, id: string, email: string, historyId = "100"): void {
  upsertAccount(db, { id, email });
  updateAccount(db, id, { auth_state: "ok", sync_state: "live", history_id: historyId });
}

function accountsOf(clients: Record<string, GmailClient>): SyncAccounts {
  return {
    client: (id) => clients[id] ?? null,
    ownerAddresses: () => ["you@example.com"],
    status: () => ({ accounts: [], configPath: "", configError: null }),
    onAuthExpired: null,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("one run per account at a time, and a poke during a run is honoured right after it", async () => {
  const db = tempDb();
  liveAccount(db, "arcforma", "you@example.com");
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => (release = r));
  let historyCalls = 0;
  const { transport } = transportOf(async (call) => {
    if (/\/history\?/.test(call.url)) {
      historyCalls += 1;
      if (historyCalls === 1) await gate;
      return { status: 200, body: { historyId: String(100 + historyCalls), history: [] } };
    }
    throw new Error(`unexpected ${call.url}`);
  });
  const client = new GmailClient({ accessToken: async () => "t", transport, sleep: async () => {} });
  const sync = new SyncManager(db, accountsOf({ arcforma: client }), { pollFocusedMs: 60_000, pollHiddenMs: 60_000 });
  const first = sync.run("arcforma");
  const second = sync.run("arcforma");
  assert.equal(first, second, "a second run while one is in flight is the same promise, never a parallel loop");
  assert.equal(sync.isRunning("arcforma"), true);
  sync.poke("arcforma", 10);
  release!();
  await first;
  assert.equal(historyCalls, 1);
  await sleep(120);
  assert.equal(historyCalls, 2, "the poke that arrived mid-run triggered a fresh run afterwards");
  assert.equal(getAccount(db, "arcforma")!.history_id, "102", "the watermark follows each completed poll");
  sync.stop();
});

test("after the outbox acks, the thread is re-read so remote changes masked meanwhile land", async () => {
  const db = tempDb();
  liveAccount(db, "arcforma", "you@example.com");
  upsertThreadFromGmail(db, "arcforma", gmailThread("t1", [{ id: "m1", labels: ["INBOX", "UNREAD"] }]));
  const outboxId = archive(db, "arcforma", "t1");
  const { transport, calls } = transportOf((call) => {
    if (/\/history\?/.test(call.url)) {
      // Gmail web starred the message while the archive was still queued locally.
      return { status: 200, body: { historyId: "150", history: [{ id: "120", labelsAdded: [{ message: { id: "m1", threadId: "t1" }, labelIds: ["STARRED"] }] }] } };
    }
    if (/threads\/t1\/modify$/.test(call.url)) return { status: 200, body: { id: "t1" } };
    if (/batch/.test(call.url)) {
      // After the modify, Gmail's view of the thread: starred, read, archived.
      return batchResponse(idsInBatch(call.init.body).map((id, i) => ({ id: `item${i}`, status: 200, body: gmailThread(id, [{ id: "m1", labels: ["STARRED"] }]) })));
    }
    throw new Error(`unexpected ${call.url}`);
  });
  const client = new GmailClient({ accessToken: async () => "t", transport, sleep: async () => {} });
  const sync = new SyncManager(db, accountsOf({ arcforma: client }), { pollFocusedMs: 60_000 });
  await sync.run("arcforma");
  sync.stop();
  assert.equal(listOutbox(db, "arcforma", "done").map((r) => r.id).includes(outboxId), true, "the archive drained");
  const t1 = getThread(db, "arcforma", "t1")!;
  assert.equal(t1.in_inbox, 0, "the local archive held");
  assert.equal(t1.starred, 1, "the star that history masked was picked up by the post-ack refetch");
  assert.equal(getAccount(db, "arcforma")!.history_id, "150");
  assert.equal(calls.filter((c) => /batch/.test(c.url)).length, 1, "exactly one reconcile fetch");
});

test("an expired watermark reruns a 7-day backfill without touching snoozes, drafts, or the pending outbox", async () => {
  const db = tempDb();
  liveAccount(db, "arcforma", "you@example.com", "5");
  upsertThreadFromGmail(db, "arcforma", gmailThread("t1", [{ id: "m1", labels: ["INBOX"] }]));
  upsertThreadFromGmail(db, "arcforma", gmailThread("t2", [{ id: "m2", labels: ["INBOX"] }]));
  const snooze = createSnooze(db, { accountId: "arcforma", threadId: "t2", wakeAt: T0 + 86_400_000 });
  const draftId = saveDraft(db, { accountId: "arcforma", threadId: "t1", to: [], subject: "Draft", bodyHtml: "<p>keep me</p>" });
  const pendingBefore = listOutbox(db, "arcforma", "pending").length;
  // Gmail's side: t2 is still in the inbox until the queued snooze modify lands.
  const gmailLabels: Record<string, string[]> = { t1: ["INBOX"], t2: ["INBOX"] };
  const { transport, calls } = transportOf((call) => {
    if (/\/history\?/.test(call.url)) return { status: 404, body: { error: { code: 404, message: "Requested entity was not found." } } };
    if (/\/profile$/.test(call.url)) return { status: 200, body: { emailAddress: "you@example.com", historyId: "900" } };
    if (/\/threads\?/.test(call.url)) return { status: 200, body: { threads: [{ id: "t1" }, { id: "t2" }], resultSizeEstimate: 2 } };
    if (/\/labels$/.test(call.url)) return { status: 200, body: { labels: [{ id: "Label_1", name: "Arcforma/Snoozed", type: "user" }] } };
    if (/labels$/.test(call.url) && call.init.method === "POST") return { status: 200, body: { id: "Label_1", name: "Arcforma/Snoozed" } };
    if (/threads\/t2\/modify$/.test(call.url)) {
      gmailLabels["t2"] = ["Label_1"];
      return { status: 200, body: {} };
    }
    if (/batch/.test(call.url)) {
      return batchResponse(idsInBatch(call.init.body).map((id, i) => ({ id: `item${i}`, status: 200, body: gmailThread(id, [{ id: id === "t1" ? "m1" : "m2", labels: gmailLabels[id]! }]) })));
    }
    throw new Error(`unexpected ${call.url}`);
  });
  const client = new GmailClient({ accessToken: async () => "t", transport, sleep: async () => {} });
  const sync = new SyncManager(db, accountsOf({ arcforma: client }), { pollFocusedMs: 60_000 });
  await sync.run("arcforma");
  sync.stop();
  const list = calls.find((c) => /\/threads\?/.test(c.url))!;
  assert.match(decodeURIComponent(list.url), /newer_than:7d/, "the recovery backfill covers the last week");
  const account = getAccount(db, "arcforma")!;
  assert.equal(account.sync_state, "live");
  assert.equal(account.history_id, "900", "the new watermark is the profile's, recorded before the list call");
  assert.equal(account.error, null);
  assert.equal(db.prepare("SELECT status FROM snoozes WHERE id = ?").get(snooze.id)?.["status"], "pending", "the snooze survived");
  assert.equal(listDrafts(db).some((d) => d.id === draftId), true, "the draft survived");
  const batches = calls.filter((c) => /batch/.test(c.url));
  assert.equal(batches.length, 2, "the backfill page, then the post-ack reconcile of t2");
  assert.equal(getThread(db, "arcforma", "t2")!.in_inbox, 0, "the snoozed thread never popped back into the inbox: masked during the backfill, then confirmed by Gmail");
  assert.ok(listOutbox(db, "arcforma", "done").length >= pendingBefore, "the pending outbox row drained rather than being dropped");
  assert.equal(listThreadMessages(db, "arcforma", "t1").length, 1);
});

test("an error on one account never stalls the others", async () => {
  const db = tempDb();
  liveAccount(db, "arcforma", "you@example.com", "10");
  liveAccount(db, "personal", "you@gmail.com", "20");
  const broken = transportOf(() => ({ status: 500, body: { error: { message: "backend" } } }));
  const fine = transportOf((call) => {
    if (/\/history\?/.test(call.url)) return { status: 200, body: { historyId: "21", history: [] } };
    throw new Error(`unexpected ${call.url}`);
  });
  const clients = {
    arcforma: new GmailClient({ accessToken: async () => "t", transport: broken.transport, sleep: async () => {}, maxAttempts: 1 }),
    personal: new GmailClient({ accessToken: async () => "t", transport: fine.transport, sleep: async () => {} }),
  };
  const sync = new SyncManager(db, accountsOf(clients), { pollFocusedMs: 60_000 });
  await Promise.all([sync.run("arcforma"), sync.run("personal")]);
  sync.stop();
  assert.equal(getAccount(db, "personal")!.history_id, "21", "the healthy account advanced");
  assert.equal(getAccount(db, "arcforma")!.history_id, "10", "the failing account kept its watermark for the next try");
  assert.match(getAccount(db, "arcforma")!.error ?? "", /backend/);
  assert.equal(getAccount(db, "arcforma")!.auth_state, "ok", "a server error is not an auth problem");
});

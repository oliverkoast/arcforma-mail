import { test } from "node:test";
import assert from "node:assert/strict";
import { GmailClient, type Transport } from "@arcforma/gmail";
import { getCalendarSync, listEventsInRange, openStore, upsertAccount, upsertCalendarEvents, updateAccount, type Db } from "@arcforma/store";
import { CalendarSync, WINDOW_BEHIND_DAYS, WINDOW_DAYS, WINDOW_REFRESH_MS, type CalendarAccounts } from "./calendar.js";

const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
const H = 3_600_000;
const D = 24 * H;

interface Canned {
  status: number;
  body?: unknown;
}

interface Call {
  url: string;
  auth: string | undefined;
}

function harness(handler: (call: Call, index: number) => Canned) {
  const calls: Call[] = [];
  const transport: Transport = async (url, init) => {
    const call = { url, auth: init.headers?.["Authorization"] };
    const canned = handler(call, calls.length);
    calls.push(call);
    return { status: canned.status, headers: { get: () => null }, text: async () => (canned.body === undefined ? "" : JSON.stringify(canned.body)) };
  };
  return { transport, calls };
}

function timed(id: string, summary: string, startAt: number, minutes = 30, extra: Record<string, unknown> = {}) {
  return { id, summary, status: "confirmed", start: { dateTime: new Date(startAt).toISOString() }, end: { dateTime: new Date(startAt + minutes * 60_000).toISOString() }, ...extra };
}

function seeded(): { db: Db; accounts: CalendarAccounts; tokens: Record<string, string> } {
  const db = openStore(":memory:");
  upsertAccount(db, { id: "arcforma", email: "you@example.com" });
  upsertAccount(db, { id: "personal", email: "you@gmail.com", consent: "external" });
  upsertAccount(db, { id: "formai", email: "you@example.net" });
  updateAccount(db, "arcforma", { auth_state: "ok" });
  updateAccount(db, "personal", { auth_state: "ok" });
  updateAccount(db, "formai", { auth_state: "signed_out" });
  const tokens: Record<string, string> = { arcforma: "tok-arcforma", personal: "tok-personal", formai: "tok-formai" };
  const clients = new Map<string, GmailClient>();
  const accounts: CalendarAccounts = {
    client(id) {
      if (!tokens[id]) return null;
      let c = clients.get(id);
      if (!c) {
        c = new GmailClient({ accessToken: async () => tokens[id]! });
        clients.set(id, c);
      }
      return c;
    },
  };
  return { db, accounts, tokens };
}

const noSleep = async () => undefined;

test("first run is a full window fetch; later runs are incremental until the token lifetime lapses, then the window is refetched and stale rows inside it go", async () => {
  const { db, accounts } = seeded();
  let now = T0;
  // An old meeting well behind the window that no sync response will ever list again: it must survive every full sync.
  upsertCalendarEvents(db, "arcforma", "primary", [{ id: "ancient", summary: "Kickoff in July", startAt: T0 - 45 * D, endAt: T0 - 45 * D + H, allDay: false, status: "confirmed", busy: true, responseStatus: "accepted", hangoutLink: null, organizerEmail: null, attendees: [] }]);
  const { transport, calls } = harness((call) => {
    if (call.auth !== "Bearer tok-arcforma") return { status: 200, body: { items: [], nextSyncToken: "p-1" } };
    const u = new URL(call.url);
    const token = u.searchParams.get("syncToken");
    if (!token) {
      // Full window: two events now, and on the second full sync one of them is missing (deleted remotely without a cancellation record).
      const items = calls.filter((c) => c.auth === call.auth && !new URL(c.url).searchParams.get("syncToken")).length === 0 ? [timed("a", "Design review", T0 + 2 * H), timed("b", "Dropped later", T0 + 5 * H)] : [timed("a", "Design review", T0 + 2 * H), timed("c", "New after refresh", T0 + 20 * D)];
      return { status: 200, body: { items, nextSyncToken: `full-${calls.length}` } };
    }
    return { status: 200, body: { items: [{ id: "a", status: "cancelled" }, timed("d", "Added incrementally", T0 + 3 * H)], nextSyncToken: `inc-${calls.length}` } };
  });
  const sync = new CalendarSync(db, accounts, { transport, now: () => now, sleep: noSleep });

  await sync.runOne("arcforma");
  const first = new URL(calls[0]!.url);
  assert.equal(first.searchParams.get("syncToken"), null);
  assert.equal(first.searchParams.get("timeMin"), new Date(T0 - WINDOW_BEHIND_DAYS * D).toISOString());
  assert.equal(first.searchParams.get("timeMax"), new Date(T0 + WINDOW_DAYS * D).toISOString());
  assert.equal(calls[0]!.auth, "Bearer tok-arcforma");
  let ids = listEventsInRange(db, T0 - 60 * D, T0 + 60 * D, ["arcforma"]).map((e) => e.id);
  assert.deepEqual(ids, ["ancient", "a", "b"]);
  const state1 = getCalendarSync(db, "arcforma", "primary");
  assert.equal(state1?.sync_token, "full-0");
  assert.equal(state1?.sync_token_expires_at, T0 + WINDOW_REFRESH_MS, "a full sync starts the token lifetime");

  now = T0 + 5 * 60_000;
  await sync.runOne("arcforma");
  assert.equal(new URL(calls[1]!.url).searchParams.get("syncToken"), "full-0", "the stored token drives the second run");
  ids = listEventsInRange(db, T0 - 60 * D, T0 + 60 * D, ["arcforma"]).map((e) => e.id);
  assert.deepEqual(ids, ["ancient", "d", "b"], "the cancellation removed a, the addition landed");
  const state2 = getCalendarSync(db, "arcforma", "primary");
  assert.equal(state2?.sync_token, "inc-1");
  assert.equal(state2?.sync_token_expires_at, T0 + WINDOW_REFRESH_MS, "an incremental run keeps the lifetime of the window it inherited");

  now = T0 + WINDOW_REFRESH_MS + 1;
  await sync.runOne("arcforma");
  const third = new URL(calls[2]!.url);
  assert.equal(third.searchParams.get("syncToken"), null, "an expired token means a full window fetch");
  assert.equal(third.searchParams.get("timeMin"), new Date(now - WINDOW_BEHIND_DAYS * D).toISOString(), "the window moves with the clock");
  ids = listEventsInRange(db, T0 - 60 * D, T0 + 60 * D, ["arcforma"]).map((e) => e.id);
  assert.deepEqual(ids, ["ancient", "a", "c"], "b and d were missing from the snapshot and went; the meeting outside the window stayed");
  assert.equal(getCalendarSync(db, "arcforma", "primary")?.sync_token_expires_at, now + WINDOW_REFRESH_MS);
});

test("accounts sync in isolation: a failing account logs and the others still land; signed-out accounts are skipped; 403 without a rate-limit reason is a scope notice", async () => {
  const { db, accounts } = seeded();
  const { transport, calls } = harness((call) => {
    if (call.auth === "Bearer tok-arcforma") return { status: 500, body: { error: { message: "backend error" } } };
    if (call.auth === "Bearer tok-personal") return { status: 200, body: { items: [timed("p1", "Dentist", T0 + 3 * H)], nextSyncToken: "p-1" } };
    throw new Error(`unexpected account ${call.auth}`);
  });
  const sync = new CalendarSync(db, accounts, { transport, now: () => T0, sleep: noSleep });
  await sync.runAll();
  assert.equal(calls.filter((c) => c.auth === "Bearer tok-formai").length, 0, "a signed-out account is never called");
  assert.equal(calls.filter((c) => c.auth === "Bearer tok-arcforma").length, 5, "the failing account retried up to the limit and gave up");
  assert.deepEqual(listEventsInRange(db, T0 - D, T0 + D).map((e) => `${e.account_id}:${e.id}`), ["personal:p1"], "the healthy account synced regardless");
  assert.equal(getCalendarSync(db, "arcforma", "primary"), null, "no token is recorded for the run that failed");
  assert.equal(getCalendarSync(db, "personal", "primary")?.sync_token, "p-1");

  // A 403 for a missing scope is not retried and not treated as a failure to rethrow.
  const scope = harness(() => ({ status: 403, body: { error: { message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] } } }));
  const sync2 = new CalendarSync(db, accounts, { transport: scope.transport, now: () => T0, sleep: noSleep });
  await sync2.runOne("arcforma");
  assert.equal(scope.calls.length, 1);
  assert.equal(sync2.isRunning("arcforma"), false);
});

test("a run already in flight for an account is not started twice", async () => {
  const { db, accounts } = seeded();
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => (release = r));
  const { transport, calls } = harness(() => ({ status: 200, body: { items: [], nextSyncToken: "x" } }));
  const slow: Transport = async (url, init) => {
    await gate;
    return transport(url, init);
  };
  const sync = new CalendarSync(db, accounts, { transport: slow, now: () => T0, sleep: noSleep });
  const a = sync.runOne("arcforma");
  const b = sync.runOne("arcforma");
  assert.equal(sync.isRunning("arcforma"), true);
  release!();
  await Promise.all([a, b]);
  assert.equal(calls.length, 1);
  assert.equal(sync.isRunning("arcforma"), false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthExpiredError, createTokenSource, type TokenTransporter } from "@arcforma/gmail";
import { getAccount, openStore, updateAccount, upsertAccount, upsertCalendarEvents, type Db } from "@arcforma/store";
import { REAUTH_MESSAGE, clearAccountOnSignOut, markAccountExpired } from "./auth-state.js";
import { accountEyebrow } from "../shared/accountState.js";
import type { AccountInfo } from "../shared/types.js";

const T0 = Date.UTC(2026, 8, 1, 12);
const H = 3_600_000;

function seeded(): Db {
  const db = openStore(":memory:");
  upsertAccount(db, { id: "personal", email: "you@gmail.com", consent: "external" });
  upsertAccount(db, { id: "arcforma", email: "you@example.com" });
  updateAccount(db, "personal", { auth_state: "ok", sync_state: "live", history_id: "900" });
  updateAccount(db, "arcforma", { auth_state: "ok", sync_state: "live" });
  return db;
}

/** The renderer's view of a row, the way AccountRegistry.toInfo builds it. */
function info(db: Db, id: string): Pick<AccountInfo, "authState" | "syncState" | "error"> {
  const row = getAccount(db, id)!;
  return { authState: row.auth_state, syncState: row.sync_state, error: row.error };
}

test("invalid_grant on the weekly personal token flips the account to expired and the sidebar shows SIGN IN AGAIN", async () => {
  const db = seeded();
  const transporter: TokenTransporter = {
    async request() {
      const err = new Error("invalid_grant") as Error & { response?: { status: number; data: { error: string } } };
      err.response = { status: 400, data: { error: "invalid_grant" } };
      throw err;
    },
  };
  let expiredFor: string | null = null;
  const source = createTokenSource({
    clientId: "c",
    clientSecret: "s",
    refreshToken: "rt-personal",
    transporter,
    onInvalidGrant: () => {
      expiredFor = "personal";
      markAccountExpired(db, "personal");
    },
  });
  assert.equal(accountEyebrow(info(db, "personal")), null, "a live account carries no eyebrow");
  await assert.rejects(source(), (e: unknown) => e instanceof AuthExpiredError);
  assert.equal(expiredFor, "personal");
  const row = getAccount(db, "personal")!;
  assert.equal(row.auth_state, "expired");
  assert.equal(row.sync_state, "reauth");
  assert.equal(row.error, REAUTH_MESSAGE);
  assert.equal(row.history_id, "900", "the watermark is kept so the next sign-in resumes instead of backfilling");
  assert.equal(accountEyebrow(info(db, "personal")), "SIGN IN AGAIN");
  assert.equal(accountEyebrow(info(db, "arcforma")), null, "the other accounts are untouched");
});

test("sign-out marks the account signed out, drops its calendar and sync token, and leaves the other accounts' calendars alone", () => {
  const db = seeded();
  const base = { allDay: false, status: "confirmed", busy: true, responseStatus: "accepted", hangoutLink: null, organizerEmail: null, attendees: [] };
  upsertCalendarEvents(db, "personal", "primary", [{ ...base, id: "p1", summary: "Dentist", startAt: T0, endAt: T0 + H }]);
  upsertCalendarEvents(db, "arcforma", "primary", [{ ...base, id: "a1", summary: "Kickoff", startAt: T0, endAt: T0 + H }]);
  db.prepare("INSERT INTO calendar_sync (account_id, calendar_id, sync_token, sync_token_expires_at, last_sync_at) VALUES ('personal', 'primary', 'tok', ?, ?)").run(T0, T0);
  updateAccount(db, "personal", { error: "some earlier sync error" });

  const result = clearAccountOnSignOut(db, "personal");
  assert.equal(result.calendarEvents, 1);
  const row = getAccount(db, "personal")!;
  assert.equal(row.auth_state, "signed_out");
  assert.equal(row.error, null);
  assert.equal(accountEyebrow(info(db, "personal")), "SIGNED OUT");
  const left = (db.prepare("SELECT account_id, id FROM calendar_events ORDER BY account_id").all() as Array<{ account_id: string; id: string }>).map((r) => `${r.account_id}:${r.id}`);
  assert.deepEqual(left, ["arcforma:a1"]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM calendar_sync WHERE account_id = 'personal'").get() as { n: number }).n, 0);
  assert.equal(accountEyebrow(info(db, "arcforma")), null);
});

test("the sidebar eyebrow order: expired beats signed out beats syncing beats a sync error", () => {
  assert.equal(accountEyebrow({ authState: "expired", syncState: "backfill", error: "x" }), "SIGN IN AGAIN");
  assert.equal(accountEyebrow({ authState: "signed_out", syncState: "new", error: null }), "SIGNED OUT");
  assert.equal(accountEyebrow({ authState: "ok", syncState: "backfill", error: "x" }), "SYNCING");
  assert.equal(accountEyebrow({ authState: "ok", syncState: "new", error: null }), "SYNCING");
  assert.equal(accountEyebrow({ authState: "ok", syncState: "live", error: "HTTP 500" }), "SYNC ERROR");
  assert.equal(accountEyebrow({ authState: "ok", syncState: "live", error: null }), null);
});

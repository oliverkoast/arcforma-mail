import type { Db } from "../db.js";
import { transaction } from "../db.js";
import type { AccountRow } from "../types.js";

export interface AccountInput {
  id: string;
  email: string;
  displayName?: string | null;
  consent?: "internal" | "external";
}

export function upsertAccount(db: Db, input: AccountInput): AccountRow {
  db.prepare(
    `INSERT INTO accounts (id, email, display_name, consent, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET email = excluded.email,
       display_name = COALESCE(excluded.display_name, accounts.display_name),
       consent = excluded.consent`
  ).run(input.id, input.email.toLowerCase(), input.displayName ?? null, input.consent ?? "internal", Date.now());
  return getAccount(db, input.id)!;
}

export function getAccount(db: Db, id: string): AccountRow | null {
  return (db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as unknown as AccountRow | undefined) ?? null;
}

export function listAccounts(db: Db): AccountRow[] {
  return db.prepare("SELECT * FROM accounts ORDER BY created_at, id").all() as unknown as AccountRow[];
}

const PATCHABLE = new Set([
  "display_name",
  "auth_state",
  "sync_state",
  "history_id",
  "backfill_cursor",
  "backfill_total",
  "backfill_done",
  "last_sync_at",
  "signature_html",
  "send_as_json",
  "error",
]);

export type AccountPatch = Partial<
  Pick<
    AccountRow,
    | "display_name"
    | "auth_state"
    | "sync_state"
    | "history_id"
    | "backfill_cursor"
    | "backfill_total"
    | "backfill_done"
    | "last_sync_at"
    | "signature_html"
    | "send_as_json"
    | "error"
  >
>;

export function updateAccount(db: Db, id: string, patch: AccountPatch): void {
  const keys = Object.keys(patch).filter((k) => PATCHABLE.has(k));
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => (patch as Record<string, unknown>)[k] as string | number | null);
  db.prepare(`UPDATE accounts SET ${sets} WHERE id = ?`).run(...values, id);
}

/** Removes the account and everything keyed by it. The FTS table has no foreign key, so it is cleared by hand. */
export function deleteAccount(db: Db, id: string): void {
  transaction(db, () => {
    db.prepare("DELETE FROM messages_fts WHERE account_id = ?").run(id);
    db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  });
}

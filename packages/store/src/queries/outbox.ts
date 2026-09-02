import type { Db } from "../db.js";
import { transaction } from "../db.js";
import { clearPendingMask } from "./labels.js";
import type { OutboxOp, OutboxRow } from "../types.js";

export interface EnqueueInput {
  accountId: string;
  op: OutboxOp;
  payload: unknown;
}

export function enqueueOutbox(db: Db, input: EnqueueInput): number {
  const now = Date.now();
  const res = db
    .prepare("INSERT INTO outbox (account_id, op, payload_json, status, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, 'pending', 0, ?, ?)")
    .run(input.accountId, input.op, JSON.stringify(input.payload), now, now);
  return Number(res.lastInsertRowid);
}

/**
 * Oldest pending row for the account, or null when it is not due yet. The
 * drain is strictly in id order: a row waiting on its retry blocks the rows
 * behind it, so an archive that is retrying can never be overtaken by the
 * unarchive queued after it.
 */
export function nextOutbox(db: Db, accountId: string, now = Date.now()): OutboxRow | null {
  const row = db.prepare("SELECT * FROM outbox WHERE account_id = ? AND status = 'pending' ORDER BY id LIMIT 1").get(accountId) as unknown as OutboxRow | undefined;
  if (!row || row.next_attempt_at > now) return null;
  return row;
}

export function listOutbox(db: Db, accountId?: string, status?: OutboxRow["status"]): OutboxRow[] {
  const where: string[] = [];
  const args: Array<string> = [];
  if (accountId) {
    where.push("account_id = ?");
    args.push(accountId);
  }
  if (status) {
    where.push("status = ?");
    args.push(status);
  }
  const sql = `SELECT * FROM outbox ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id`;
  return db.prepare(sql).all(...args) as unknown as OutboxRow[];
}

export function markOutboxInflight(db: Db, id: number): void {
  db.prepare("UPDATE outbox SET status = 'inflight', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(Date.now(), id);
}

/** Acknowledges the op: the row is done and any history mask it held is lifted. */
export function markOutboxDone(db: Db, id: number): void {
  transaction(db, () => {
    db.prepare("UPDATE outbox SET status = 'done', error = NULL, updated_at = ? WHERE id = ?").run(Date.now(), id);
    clearPendingMask(db, id);
  });
}

/** Retryable failure: back to pending with a retry time. Terminal failure: retryAt null. */
export function markOutboxFailed(db: Db, id: number, error: string, retryAt: number | null): void {
  transaction(db, () => {
    if (retryAt === null) {
      db.prepare("UPDATE outbox SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error, Date.now(), id);
      clearPendingMask(db, id);
    } else {
      db.prepare("UPDATE outbox SET status = 'pending', error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?").run(error, retryAt, Date.now(), id);
    }
  });
}

/** Rows left inflight by a crash go back to pending on startup. */
export function resetInflightOutbox(db: Db): number {
  const res = db.prepare("UPDATE outbox SET status = 'pending', updated_at = ? WHERE status = 'inflight'").run(Date.now());
  return Number(res.changes);
}

export function pendingOutboxCount(db: Db, accountId?: string): number {
  const row = accountId
    ? (db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending' AND account_id = ?").get(accountId) as { n: number })
    : (db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'").get() as { n: number });
  return row.n;
}

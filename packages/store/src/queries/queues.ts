// Daily 0, Weekly 0, and Later. A thread is in at most one queue. Manual
// choices (D, W, a snooze wake, a reminder firing, a rollover) are rows in
// queue_items; the automatic part of Daily 0 is computed live: an important
// thread in the inbox whose last inbound message is newer than dayStartAt.
// A row with queue = 'none' is the user taking an automatic thread out with
// D; it stops applying once a newer inbound message arrives.
//
// E clears a thread: the clear is logged for "You cleared N today" and the
// row is deleted. Snoozing deletes the row without a clear; the wake puts
// the thread back in Daily 0.

import type { Db } from "../db.js";
import { placeholders, transaction } from "../db.js";
import { NOT_JUNK, PENDING_SNOOZE } from "./fragments.js";
import { getSetting, setSetting } from "./settings.js";

export type Queue = "daily" | "weekly" | "later";
export type QueueSource = "user" | "wake" | "reminder" | "rollover";

export const WEEK_MS = 7 * 86_400_000;

export interface QueueItemRow {
  account_id: string;
  thread_id: string;
  queue: Queue | "none";
  added_at: number;
  source: QueueSource;
}

export interface QueueCounts {
  daily: number;
  weekly: number;
  later: number;
}

export interface ClearedCounts {
  daily: number;
  weekly: number;
}

/** The join every queue-aware query needs, against alias t. */
export const QUEUE_JOIN = "LEFT JOIN queue_items q ON q.account_id = t.account_id AND q.thread_id = t.id";

function intLiteral(n: number): string {
  return String(Number.isFinite(n) ? Math.trunc(n) : 0);
}

/**
 * The queue a thread is in right now, as a SQL expression over t, c, and q.
 * dayStartAt is embedded as an integer literal so callers can keep their
 * positional parameters simple.
 */
export function effectiveQueueSql(dayStartAt: number): string {
  const auto = `(t.in_inbox = 1 AND c.split = 'important' AND t.last_inbound_at > ${intLiteral(dayStartAt)})`;
  return `CASE
    WHEN NOT (${NOT_JUNK}) OR ${PENDING_SNOOZE} THEN NULL
    WHEN q.queue IN ('daily', 'weekly', 'later') THEN q.queue
    WHEN ${auto} AND (q.queue IS NULL OR q.added_at < t.last_inbound_at) THEN 'daily'
    ELSE NULL
  END`;
}

export function queueSettings(db: Db): { dayStartAt: number; weekStartAt: number; lastActiveAt: number } {
  return { dayStartAt: getSetting(db, "dayStartAt"), weekStartAt: getSetting(db, "weekStartAt"), lastActiveAt: getSetting(db, "lastActiveAt") };
}

export function getQueueItem(db: Db, accountId: string, threadId: string): QueueItemRow | null {
  return (db.prepare("SELECT * FROM queue_items WHERE account_id = ? AND thread_id = ?").get(accountId, threadId) as unknown as QueueItemRow | undefined) ?? null;
}

/** The queue the thread is in, manual or automatic, or null. */
export function getQueue(db: Db, accountId: string, threadId: string, dayStartAt = getSetting(db, "dayStartAt")): Queue | null {
  const row = db
    .prepare(
      `SELECT ${effectiveQueueSql(dayStartAt)} AS queue FROM threads t
       LEFT JOIN classifications c ON c.account_id = t.account_id AND c.thread_id = t.id
       ${QUEUE_JOIN}
       WHERE t.account_id = ? AND t.id = ?`
    )
    .get(accountId, threadId) as { queue: Queue | null } | undefined;
  return row?.queue ?? null;
}

/** Writes the stored choice for a thread. 'none' keeps an automatic thread out of Daily 0 until newer mail arrives. */
export function setQueue(db: Db, accountId: string, threadId: string, queue: Queue | "none", source: QueueSource, now = Date.now()): void {
  db.prepare(
    `INSERT INTO queue_items (account_id, thread_id, queue, added_at, source) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(account_id, thread_id) DO UPDATE SET queue = excluded.queue, added_at = excluded.added_at, source = excluded.source`
  ).run(accountId, threadId, queue, now, source);
}

/** Drops the stored choice. Used by snooze: the wake adds the thread back to Daily 0. */
export function removeQueueItem(db: Db, accountId: string, threadId: string): void {
  db.prepare("DELETE FROM queue_items WHERE account_id = ? AND thread_id = ?").run(accountId, threadId);
}

/**
 * D and W. Pressing the key of the queue the thread is already in takes it
 * out; anything else puts it in that queue, replacing whatever it was in.
 * Returns the queue the thread ends up in.
 */
export function toggleQueue(db: Db, accountId: string, threadId: string, queue: "daily" | "weekly", now = Date.now()): Queue | null {
  return transaction(db, () => {
    const current = getQueue(db, accountId, threadId);
    if (current === queue) {
      setQueue(db, accountId, threadId, "none", "user", now);
      return null;
    }
    setQueue(db, accountId, threadId, queue, "user", now);
    return queue;
  });
}

/** E. Logs the clear against the queue the thread was in and forgets the row. Returns that queue. */
export function clearQueue(db: Db, accountId: string, threadId: string, now = Date.now()): Queue | null {
  return transaction(db, () => {
    const was = getQueue(db, accountId, threadId);
    if (was) db.prepare("INSERT INTO queue_clears (account_id, thread_id, queue, cleared_at) VALUES (?, ?, ?, ?)").run(accountId, threadId, was, now);
    removeQueueItem(db, accountId, threadId);
    return was;
  });
}

function scopeSql(accountIds?: string[]): { sql: string; args: string[] } {
  if (!accountIds || accountIds.length === 0) return { sql: "", args: [] };
  return { sql: `AND t.account_id IN (${placeholders(accountIds.length)})`, args: accountIds };
}

/** Threads in a queue right now, newest first. dayStartAt defaults to the stored one. */
export function listQueueMembers(db: Db, queue: Queue, dayStartAt = getSetting(db, "dayStartAt"), accountIds?: string[]): Array<{ account_id: string; thread_id: string }> {
  const scope = scopeSql(accountIds);
  return db
    .prepare(
      `SELECT t.account_id, t.id AS thread_id FROM threads t
       LEFT JOIN classifications c ON c.account_id = t.account_id AND c.thread_id = t.id
       ${QUEUE_JOIN}
       WHERE ${effectiveQueueSql(dayStartAt)} = ? ${scope.sql}
       ORDER BY t.sort_at DESC, t.account_id, t.id`
    )
    .all(queue, ...scope.args) as Array<{ account_id: string; thread_id: string }>;
}

export function queueCounts(db: Db, accountIds?: string[]): QueueCounts {
  const scope = scopeSql(accountIds);
  const rows = db
    .prepare(
      `SELECT queue, COUNT(*) AS n FROM (
         SELECT ${effectiveQueueSql(getSetting(db, "dayStartAt"))} AS queue FROM threads t
         LEFT JOIN classifications c ON c.account_id = t.account_id AND c.thread_id = t.id
         ${QUEUE_JOIN}
         WHERE 1 = 1 ${scope.sql}
       ) WHERE queue IS NOT NULL GROUP BY queue`
    )
    .all(...scope.args) as Array<{ queue: Queue; n: number }>;
  const out: QueueCounts = { daily: 0, weekly: 0, later: 0 };
  for (const r of rows) out[r.queue] = r.n;
  return out;
}

/** Clears since the day started (daily) and since the week started (weekly). */
export function clearedCounts(db: Db, accountIds?: string[]): ClearedCounts {
  const { dayStartAt, weekStartAt } = queueSettings(db);
  const scope = accountIds && accountIds.length ? `AND account_id IN (${placeholders(accountIds.length)})` : "";
  const args = accountIds && accountIds.length ? accountIds : [];
  const count = (queue: Queue, since: number) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM queue_clears WHERE queue = ? AND cleared_at >= ? ${scope}`).get(queue, since, ...args) as { n: number }).n;
  return { daily: count("daily", dayStartAt), weekly: count("weekly", weekStartAt) };
}

/**
 * New day: everything still in Daily 0 moves to Weekly 0, then dayStartAt
 * advances. Guarded on the stored dayStartAt, so the same boundary can only
 * roll once. The very first day moves nothing: there was no queue before it.
 * Returns how many threads moved.
 */
export function rolloverDay(db: Db, input: { dayStartAt: number; now?: number }): number {
  const now = input.now ?? Date.now();
  return transaction(db, () => {
    const current = getSetting(db, "dayStartAt");
    if (current >= input.dayStartAt) return 0;
    let moved = 0;
    if (current > 0) {
      const members = listQueueMembers(db, "daily", current);
      for (const m of members) setQueue(db, m.account_id, m.thread_id, "weekly", "rollover", now);
      moved = members.length;
    }
    setSetting(db, "dayStartAt", input.dayStartAt);
    return moved;
  });
}

/**
 * New week: Weekly 0 rows older than seven days drop to Later, then
 * weekStartAt advances. Same guard as the day rollover. Nothing is archived.
 */
export function rolloverWeek(db: Db, input: { weekStartAt: number; now?: number }): number {
  const now = input.now ?? Date.now();
  return transaction(db, () => {
    const current = getSetting(db, "weekStartAt");
    if (current >= input.weekStartAt) return 0;
    let moved = 0;
    if (current > 0) {
      const rows = db.prepare("SELECT account_id, thread_id FROM queue_items WHERE queue = 'weekly' AND added_at <= ?").all(now - WEEK_MS) as Array<{ account_id: string; thread_id: string }>;
      for (const r of rows) setQueue(db, r.account_id, r.thread_id, "later", "rollover", now);
      moved = rows.length;
    }
    setSetting(db, "weekStartAt", input.weekStartAt);
    return moved;
  });
}

/** The queue views the thread list understands. */
export const QUEUE_VIEWS: ReadonlySet<string> = new Set<Queue>(["daily", "weekly", "later"]);

export function isQueue(v: unknown): v is Queue {
  return typeof v === "string" && QUEUE_VIEWS.has(v);
}

import type { Db } from "../db.js";
import { transaction } from "../db.js";
import { bumpThread, changeThreadLabels } from "./threads.js";
import { removeQueueItem, setQueue } from "./queues.js";
import type { ReminderRow, SendQueueRow, SnoozeRow } from "../types.js";

export const SNOOZED_LABEL = "Arcforma/Snoozed";

// ---- snooze ---------------------------------------------------------------

export function createSnooze(db: Db, input: { accountId: string; threadId: string; wakeAt: number }): SnoozeRow {
  return transaction(db, () => {
    db.prepare("UPDATE snoozes SET status = 'cancelled' WHERE account_id = ? AND thread_id = ? AND status = 'pending'").run(input.accountId, input.threadId);
    const res = db
      .prepare("INSERT INTO snoozes (account_id, thread_id, wake_at, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
      .run(input.accountId, input.threadId, input.wakeAt, Date.now());
    changeThreadLabels(db, input.accountId, input.threadId, { remove: ["INBOX"], addNames: [SNOOZED_LABEL] });
    // Out of Daily 0 or Weekly 0 while it sleeps; the wake puts it in Daily 0.
    removeQueueItem(db, input.accountId, input.threadId);
    return db.prepare("SELECT * FROM snoozes WHERE id = ?").get(Number(res.lastInsertRowid)) as unknown as SnoozeRow;
  });
}

export function dueSnoozes(db: Db, now = Date.now()): SnoozeRow[] {
  return db.prepare("SELECT * FROM snoozes WHERE status = 'pending' AND wake_at <= ? ORDER BY wake_at, id").all(now) as unknown as SnoozeRow[];
}

export function pendingSnooze(db: Db, accountId: string, threadId: string): SnoozeRow | null {
  return (db.prepare("SELECT * FROM snoozes WHERE account_id = ? AND thread_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(accountId, threadId) as unknown as SnoozeRow | undefined) ?? null;
}

/** Returns the thread to the inbox at the top of the list and mirrors the label change to Gmail. */
export function wakeSnooze(db: Db, id: number, now = Date.now()): SnoozeRow | null {
  return transaction(db, () => {
    const row = db.prepare("SELECT * FROM snoozes WHERE id = ? AND status = 'pending'").get(id) as unknown as SnoozeRow | undefined;
    if (!row) return null;
    db.prepare("UPDATE snoozes SET status = 'woken', woken_at = ? WHERE id = ?").run(now, id);
    changeThreadLabels(db, row.account_id, row.thread_id, { add: ["INBOX"], removeNames: [SNOOZED_LABEL] });
    bumpThread(db, row.account_id, row.thread_id, now);
    setQueue(db, row.account_id, row.thread_id, "daily", "wake", now);
    return db.prepare("SELECT * FROM snoozes WHERE id = ?").get(id) as unknown as SnoozeRow;
  });
}

export function cancelSnooze(db: Db, id: number): SnoozeRow | null {
  return transaction(db, () => {
    const row = db.prepare("SELECT * FROM snoozes WHERE id = ? AND status = 'pending'").get(id) as unknown as SnoozeRow | undefined;
    if (!row) return null;
    db.prepare("UPDATE snoozes SET status = 'cancelled' WHERE id = ?").run(id);
    changeThreadLabels(db, row.account_id, row.thread_id, { add: ["INBOX"], removeNames: [SNOOZED_LABEL] });
    return db.prepare("SELECT * FROM snoozes WHERE id = ?").get(id) as unknown as SnoozeRow;
  });
}

// ---- remind if no reply -----------------------------------------------------

export function createReminder(db: Db, input: { accountId: string; threadId: string; lastMessageId: string; dueAt: number }): ReminderRow {
  return transaction(db, () => {
    db.prepare("UPDATE reminders SET status = 'cancelled', resolved_at = ? WHERE account_id = ? AND thread_id = ? AND status = 'pending'").run(Date.now(), input.accountId, input.threadId);
    const res = db
      .prepare("INSERT INTO reminders (account_id, thread_id, last_message_id, due_at, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
      .run(input.accountId, input.threadId, input.lastMessageId, input.dueAt, Date.now());
    return db.prepare("SELECT * FROM reminders WHERE id = ?").get(Number(res.lastInsertRowid)) as unknown as ReminderRow;
  });
}

export function dueReminders(db: Db, now = Date.now()): ReminderRow[] {
  return db.prepare("SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at, id").all(now) as unknown as ReminderRow[];
}

/** True when an inbound message newer than the one the reminder was set on has arrived. */
export function hasNewerInbound(db: Db, accountId: string, threadId: string, lastMessageId: string): boolean {
  const anchor = db.prepare("SELECT internal_date FROM messages WHERE account_id = ? AND id = ?").get(accountId, lastMessageId) as { internal_date: number } | undefined;
  const since = anchor?.internal_date ?? 0;
  const row = db
    .prepare("SELECT 1 FROM messages WHERE account_id = ? AND thread_id = ? AND direction = 'in' AND internal_date > ? AND id != ? LIMIT 1")
    .get(accountId, threadId, since, lastMessageId);
  return Boolean(row);
}

export function resolveReminder(db: Db, id: number, status: "fired" | "replied" | "cancelled", now = Date.now()): void {
  db.prepare("UPDATE reminders SET status = ?, resolved_at = ? WHERE id = ?").run(status, now, id);
}

export function pendingReminder(db: Db, accountId: string, threadId: string): ReminderRow | null {
  return (db.prepare("SELECT * FROM reminders WHERE account_id = ? AND thread_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(accountId, threadId) as unknown as ReminderRow | undefined) ?? null;
}

// ---- send queue (undo send, send later) --------------------------------------

export interface EnqueueSendInput {
  accountId: string;
  threadId?: string | null;
  rawMime: string;
  sendAt: number;
  undoUntil: number;
  meta?: unknown;
}

export function enqueueSend(db: Db, input: EnqueueSendInput): SendQueueRow {
  const now = Date.now();
  const res = db
    .prepare(
      "INSERT INTO send_queue (account_id, thread_id, raw_mime, meta_json, send_at, undo_until, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)"
    )
    .run(input.accountId, input.threadId ?? null, input.rawMime, JSON.stringify(input.meta ?? {}), input.sendAt, input.undoUntil, now, now);
  return db.prepare("SELECT * FROM send_queue WHERE id = ?").get(Number(res.lastInsertRowid)) as unknown as SendQueueRow;
}

/** Cancels only while still queued. Returns false once the worker has picked the row up. */
export function cancelSend(db: Db, id: number): boolean {
  const res = db.prepare("UPDATE send_queue SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'queued'").run(Date.now(), id);
  return Number(res.changes) === 1;
}

export function releasableSends(db: Db, now = Date.now()): SendQueueRow[] {
  return db.prepare("SELECT * FROM send_queue WHERE status = 'queued' AND send_at <= ? ORDER BY send_at, id").all(now) as unknown as SendQueueRow[];
}

export function markSending(db: Db, id: number): boolean {
  const res = db.prepare("UPDATE send_queue SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'").run(Date.now(), id);
  return Number(res.changes) === 1;
}

export function markSent(db: Db, id: number, gmailMessageId: string): void {
  db.prepare("UPDATE send_queue SET status = 'sent', gmail_message_id = ?, error = NULL, updated_at = ? WHERE id = ?").run(gmailMessageId, Date.now(), id);
}

export function markSendFailed(db: Db, id: number, error: string, retryAt: number | null): void {
  if (retryAt === null) {
    db.prepare("UPDATE send_queue SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error, Date.now(), id);
  } else {
    db.prepare("UPDATE send_queue SET status = 'queued', error = ?, send_at = ?, updated_at = ? WHERE id = ?").run(error, retryAt, Date.now(), id);
  }
}

/**
 * Rows still marked sending after a restart were interrupted between the API
 * call and the ack, so the message may or may not have gone out. They are
 * failed rather than resent: a duplicate email is worse than a visible miss.
 * Returns the rows so the caller can put the drafts back and tell the user.
 */
export function failInterruptedSends(db: Db, now = Date.now()): SendQueueRow[] {
  return transaction(db, () => {
    const rows = db.prepare("SELECT * FROM send_queue WHERE status = 'sending' ORDER BY id").all() as unknown as SendQueueRow[];
    for (const r of rows) {
      db.prepare("UPDATE send_queue SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run("Interrupted while sending. Check Sent before sending again.", now, r.id);
    }
    return rows;
  });
}

/**
 * Gmail draft ids carried by sends that have not gone out yet. Their Gmail
 * drafts still exist (they are deleted once the send succeeds) and must not be
 * imported as new drafts in the meantime.
 */
export function queuedGmailDraftIds(db: Db, accountId: string): Set<string> {
  const rows = db.prepare("SELECT meta_json FROM send_queue WHERE account_id = ? AND status IN ('queued', 'sending')").all(accountId) as Array<{ meta_json: string }>;
  const out = new Set<string>();
  for (const r of rows) {
    try {
      const id = (JSON.parse(r.meta_json) as { gmailDraftId?: string | null }).gmailDraftId;
      if (id) out.add(id);
    } catch {
      // Meta that does not parse carries no draft id.
    }
  }
  return out;
}

export function getSend(db: Db, id: number): SendQueueRow | null {
  return (db.prepare("SELECT * FROM send_queue WHERE id = ?").get(id) as unknown as SendQueueRow | undefined) ?? null;
}

export function listSends(db: Db, status?: SendQueueRow["status"]): SendQueueRow[] {
  return status
    ? (db.prepare("SELECT * FROM send_queue WHERE status = ? ORDER BY send_at, id").all(status) as unknown as SendQueueRow[])
    : (db.prepare("SELECT * FROM send_queue ORDER BY send_at, id").all() as unknown as SendQueueRow[]);
}

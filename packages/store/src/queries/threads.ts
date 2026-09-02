import type { Db } from "../db.js";
import { placeholders, transaction } from "../db.js";
import { addPendingMask, hasPendingMask, labelIdByName, listPendingMasks } from "./labels.js";
import { deleteMessage, getMessage, listThreadMessages, recomputeThread, setMessageLabels, upsertMessage, type UpsertContext } from "./messages.js";
import { enqueueOutbox } from "./outbox.js";
import { HAS_LABEL, NOT_JUNK, PENDING_SNOOZE } from "./fragments.js";
import { QUEUE_JOIN, clearQueue, effectiveQueueSql, isQueue, queueCounts, clearedCounts } from "./queues.js";
import { getSetting } from "./settings.js";
import { CAN_UNSUBSCRIBE, UNSUBSCRIBE_STATE } from "./unsubscribe.js";
import type { ApplyHistoryResult, GmailThreadInput, HistoryChange, ListThreadsOptions, ListThreadsResult, ModifyLabelsPayload, ThreadListRow, ThreadRow } from "../types.js";

const BUILTIN_TYPES = new Set(["newsletters", "promotions", "jobs", "calendar", "notifications", "receipts"]);

/**
 * Re-applies unacknowledged local label changes on top of what Gmail just
 * returned, so a thread refetch (a new reply on a thread archived offline, or
 * a backfill while the outbox is still draining) never undoes a local change.
 * Names that are not in the labels table yet are skipped; the drain resolves them.
 */
function reapplyPendingMasks(db: Db, accountId: string, threadId: string): void {
  const masks = listPendingMasks(db, accountId, threadId);
  if (masks.length === 0) return;
  const resolve = (l: string) => (l.includes("/") || /[a-z]/.test(l) ? labelIdByName(db, accountId, l) : l);
  for (const m of listThreadMessages(db, accountId, threadId, { includeDrafts: true })) {
    const labels = new Set(JSON.parse(m.label_ids_json) as string[]);
    for (const mask of masks) {
      for (const l of mask.remove) {
        const id = resolve(l);
        if (id) labels.delete(id);
      }
      for (const l of mask.add) {
        const id = resolve(l);
        if (id) labels.add(id);
      }
    }
    setMessageLabels(db, accountId, m.id, Array.from(labels));
  }
}

/** Writes a threads.get result (metadata or full) and recomputes the thread row. */
export function upsertThreadFromGmail(db: Db, accountId: string, thread: GmailThreadInput, ctx: UpsertContext = {}): ThreadRow | null {
  return transaction(db, () => {
    // The thread row must exist before messages reference it; recompute fills it in afterwards.
    db.prepare("INSERT OR IGNORE INTO threads (account_id, id, history_id, updated_at) VALUES (?, ?, ?, ?)").run(accountId, thread.id, thread.historyId ?? null, Date.now());
    const seen = new Set<string>();
    for (const m of thread.messages ?? []) {
      upsertMessage(db, accountId, { ...m, threadId: thread.id }, ctx);
      seen.add(m.id);
    }
    // A full thread response is authoritative: messages Gmail no longer lists are gone. That
    // includes the DRAFT-labelled message behind a draft deleted or re-saved in Gmail, which
    // otherwise sits in the table for good.
    if ((thread.messages ?? []).length > 0) {
      for (const m of listThreadMessages(db, accountId, thread.id, { includeDrafts: true })) {
        if (!seen.has(m.id)) deleteMessage(db, accountId, m.id);
      }
    }
    reapplyPendingMasks(db, accountId, thread.id);
    const row = recomputeThread(db, accountId, thread.id, { keepSortAt: true });
    if (row && thread.historyId) db.prepare("UPDATE threads SET history_id = ? WHERE account_id = ? AND id = ?").run(thread.historyId, accountId, thread.id);
    return row;
  });
}

export function getThread(db: Db, accountId: string, threadId: string): ThreadRow | null {
  return (db.prepare("SELECT * FROM threads WHERE account_id = ? AND id = ?").get(accountId, threadId) as unknown as ThreadRow | undefined) ?? null;
}

function encodeCursor(row: ThreadListRow): string {
  return Buffer.from(JSON.stringify([row.sort_at, row.account_id, row.id])).toString("base64url");
}

function decodeCursor(cursor: string): [number, string, string] | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(v) && v.length === 3 && typeof v[0] === "number") return v as [number, string, string];
  } catch {
    // A bad cursor restarts from the top rather than failing the list.
  }
  return null;
}

/** The latest fired reminder whose thread has not moved since it fired. */
export const NO_REPLY_BY =
  "(SELECT r.due_at FROM reminders r WHERE r.account_id = t.account_id AND r.thread_id = t.id AND r.status = 'fired' AND r.resolved_at >= t.last_message_at ORDER BY r.id DESC LIMIT 1)";
/** Keyset-paginated thread list for the sidebar views and the split inbox. */
export function listThreads(db: Db, opts: ListThreadsOptions = {}): ListThreadsResult {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const view = opts.view ?? "inbox";
  // Spam and Trash are the two views that look inside the junk; every other list starts from NOT_JUNK.
  const where: string[] = [view === "spam" ? HAS_LABEL("SPAM") : view === "trash" ? HAS_LABEL("TRASH") : NOT_JUNK];
  const args: Array<string | number> = [];
  const queueSql = effectiveQueueSql(getSetting(db, "dayStartAt"));
  if (opts.accountIds && opts.accountIds.length > 0) {
    where.push(`t.account_id IN (${placeholders(opts.accountIds.length)})`);
    args.push(...opts.accountIds);
  }
  if (isQueue(view)) where.push(`${queueSql} = '${view}'`);
  switch (view) {
    case "needsyou":
      // The promise of the row: a person asked, and he has not answered. Only mail still in the
      // inbox and awake, because a thread he archived or snoozed is one he has already dealt with.
      where.push("c.band = 'needs_you'", "t.in_inbox = 1", `NOT ${PENDING_SNOOZE}`);
      break;
    case "inbox":
      where.push("t.in_inbox = 1", `NOT ${PENDING_SNOOZE}`);
      break;
    case "unread":
      where.push("t.in_inbox = 1", "t.unread = 1", `NOT ${PENDING_SNOOZE}`);
      break;
    case "attachments":
      where.push("t.has_attachments = 1");
      break;
    case "archive":
      // All Mail minus the inbox: what E moved out, minus what is only sleeping.
      where.push("t.in_inbox = 0", `NOT ${PENDING_SNOOZE}`);
      break;
    case "snoozed":
      where.push(PENDING_SNOOZE);
      break;
    case "sent":
      where.push(HAS_LABEL("SENT"));
      break;
    case "drafts":
      where.push(HAS_LABEL("DRAFT"));
      break;
    case "starred":
      where.push("t.starred = 1");
      break;
    case "all":
    case "spam":
    case "trash":
    case "daily":
    case "weekly":
    case "later":
      break;
  }
  if (opts.split === "important") where.push("c.split = 'important'");
  else if (opts.split === "other") where.push("(c.split IS NULL OR c.split = 'other')");
  if (opts.category) {
    if (BUILTIN_TYPES.has(opts.category)) {
      where.push("c.type = ?");
    } else {
      where.push("c.category_id = ?");
    }
    args.push(opts.category);
  }
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (cursor) {
    where.push("(t.sort_at < ? OR (t.sort_at = ? AND (t.account_id > ? OR (t.account_id = ? AND t.id > ?))))");
    args.push(cursor[0], cursor[0], cursor[1], cursor[1], cursor[2]);
  }
  const sql = `${threadListSelect(queueSql)}
    WHERE ${where.join(" AND ")}
    ORDER BY t.sort_at DESC, t.account_id, t.id
    LIMIT ?`;
  const rows = db.prepare(sql).all(...args, limit + 1) as unknown as ThreadListRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { rows: page, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}

/** The SELECT and joins behind every thread list row: the thread, its classification, snooze, reminder, queue, and unsubscribe state. */
function threadListSelect(queueSql: string): string {
  return `SELECT t.*, c.split, c.type, c.category_id, c.attention, c.band, c.reason AS attention_reason,
      (SELECT s.wake_at FROM snoozes s WHERE s.account_id = t.account_id AND s.thread_id = t.id AND s.status = 'pending' ORDER BY s.id DESC LIMIT 1) AS wake_at,
      ${NO_REPLY_BY} AS no_reply_by,
      ${queueSql} AS queue,
      ${UNSUBSCRIBE_STATE} AS unsubscribe_state,
      ${CAN_UNSUBSCRIBE} AS can_unsubscribe
    FROM threads t
    LEFT JOIN classifications c ON c.account_id = t.account_id AND c.thread_id = t.id
    ${QUEUE_JOIN}`;
}

/** One thread with the same columns a list row carries, for the reading pane header. Null when the thread is gone. */
export function getThreadListRow(db: Db, accountId: string, threadId: string): ThreadListRow | null {
  const queueSql = effectiveQueueSql(getSetting(db, "dayStartAt"));
  const row = db.prepare(`${threadListSelect(queueSql)} WHERE t.account_id = ? AND t.id = ?`).get(accountId, threadId) as unknown as ThreadListRow | undefined;
  return row ?? null;
}

/** Convenience alias used by the desktop IPC layer. */
export const listInbox = listThreads;

export interface LabelChange {
  add?: string[];
  remove?: string[];
  addNames?: string[];
  removeNames?: string[];
}

/**
 * Applies a label change locally, queues the matching Gmail modify, and masks
 * incoming history for the thread until the outbox row is acknowledged.
 */
export function changeThreadLabels(db: Db, accountId: string, threadId: string, change: LabelChange): number {
  const add = change.add ?? [];
  const remove = change.remove ?? [];
  return transaction(db, () => {
    // threads.modify touches every message of the thread in Gmail, drafts included; the local copy does the same.
    for (const m of listThreadMessages(db, accountId, threadId, { includeDrafts: true })) {
      const labels = new Set(JSON.parse(m.label_ids_json) as string[]);
      for (const l of remove) labels.delete(l);
      for (const l of add) labels.add(l);
      setMessageLabels(db, accountId, m.id, Array.from(labels));
    }
    recomputeThread(db, accountId, threadId, { keepSortAt: true });
    const payload: ModifyLabelsPayload = { threadId, addLabelIds: add, removeLabelIds: remove };
    if (change.addNames?.length) payload.addLabelNames = change.addNames;
    if (change.removeNames?.length) payload.removeLabelNames = change.removeNames;
    const outboxId = enqueueOutbox(db, { accountId, op: "modifyLabels", payload });
    addPendingMask(db, accountId, threadId, outboxId, [...add, ...(change.addNames ?? [])], [...remove, ...(change.removeNames ?? [])]);
    return outboxId;
  });
}

export function markRead(db: Db, accountId: string, threadId: string, read = true): number {
  return changeThreadLabels(db, accountId, threadId, read ? { remove: ["UNREAD"] } : { add: ["UNREAD"] });
}

export function star(db: Db, accountId: string, threadId: string, starred = true): number {
  return changeThreadLabels(db, accountId, threadId, starred ? { add: ["STARRED"] } : { remove: ["STARRED"] });
}

/** E. Done means out of the inbox and out of whichever queue it was in. */
export function archive(db: Db, accountId: string, threadId: string): number {
  return transaction(db, () => {
    clearQueue(db, accountId, threadId);
    return changeThreadLabels(db, accountId, threadId, { remove: ["INBOX"] });
  });
}

export function moveToInbox(db: Db, accountId: string, threadId: string): number {
  return changeThreadLabels(db, accountId, threadId, { add: ["INBOX"] });
}

export function trash(db: Db, accountId: string, threadId: string): number {
  return transaction(db, () => {
    clearQueue(db, accountId, threadId);
    for (const m of listThreadMessages(db, accountId, threadId, { includeDrafts: true })) {
      const labels = new Set(JSON.parse(m.label_ids_json) as string[]);
      labels.delete("INBOX");
      labels.add("TRASH");
      setMessageLabels(db, accountId, m.id, Array.from(labels));
    }
    recomputeThread(db, accountId, threadId, { keepSortAt: true });
    const outboxId = enqueueOutbox(db, { accountId, op: "trash", payload: { threadId } });
    addPendingMask(db, accountId, threadId, outboxId, ["TRASH"], ["INBOX"]);
    return outboxId;
  });
}

/** Bumps a thread to the top of the list without changing its messages (snooze wake, reminder). */
export function bumpThread(db: Db, accountId: string, threadId: string, sortAt = Date.now()): void {
  db.prepare("UPDATE threads SET sort_at = ?, updated_at = ? WHERE account_id = ? AND id = ?").run(sortAt, Date.now(), accountId, threadId);
}

/**
 * Replays normalized history.list records in order. Label changes for a thread
 * with a pending local change are skipped; the outbox ack lifts the mask and
 * the next poll reconciles. Unknown threads are returned for fetching.
 */
export function applyHistory(db: Db, accountId: string, changes: HistoryChange[]): ApplyHistoryResult {
  const toFetch = new Set<string>();
  const touched = new Set<string>();
  let masked = 0;
  let last: string | null = null;
  transaction(db, () => {
    for (const ch of changes) {
      last = ch.historyId;
      const existing = getMessage(db, accountId, ch.messageId);
      switch (ch.type) {
        case "messageAdded": {
          if (!existing) {
            toFetch.add(ch.threadId);
            break;
          }
          if (hasPendingMask(db, accountId, ch.threadId)) {
            masked += 1;
            break;
          }
          if (ch.labelIds) {
            setMessageLabels(db, accountId, ch.messageId, ch.labelIds);
            recomputeThread(db, accountId, ch.threadId, { keepSortAt: true });
            touched.add(ch.threadId);
          }
          break;
        }
        case "messageDeleted": {
          if (!existing) break;
          deleteMessage(db, accountId, ch.messageId);
          recomputeThread(db, accountId, ch.threadId, { keepSortAt: true });
          touched.add(ch.threadId);
          break;
        }
        case "labelAdded":
        case "labelRemoved": {
          if (!existing) {
            toFetch.add(ch.threadId);
            break;
          }
          if (hasPendingMask(db, accountId, ch.threadId)) {
            masked += 1;
            break;
          }
          const labels = new Set(JSON.parse(existing.label_ids_json) as string[]);
          for (const l of ch.changedLabelIds ?? []) {
            if (ch.type === "labelAdded") labels.add(l);
            else labels.delete(l);
          }
          setMessageLabels(db, accountId, ch.messageId, Array.from(labels));
          recomputeThread(db, accountId, ch.threadId, { keepSortAt: true });
          touched.add(ch.threadId);
          break;
        }
      }
    }
  });
  return { threadsToFetch: Array.from(toFetch), touched: Array.from(touched), masked, lastHistoryId: last };
}

export interface ThreadCounts {
  inbox: number;
  unread: number;
  snoozed: number;
  daily: number;
  weekly: number;
  later: number;
  /** E presses since the day started on Daily 0 threads, and since the week started on Weekly 0 threads. */
  clearedDaily: number;
  clearedWeekly: number;
}

export function threadCounts(db: Db, accountIds?: string[]): ThreadCounts {
  const scope = accountIds && accountIds.length ? `AND t.account_id IN (${placeholders(accountIds.length)})` : "";
  const args = accountIds && accountIds.length ? accountIds : [];
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN t.in_inbox = 1 AND NOT ${PENDING_SNOOZE} THEN 1 ELSE 0 END) AS inbox,
         SUM(CASE WHEN t.in_inbox = 1 AND t.unread = 1 AND NOT ${PENDING_SNOOZE} THEN 1 ELSE 0 END) AS unread,
         SUM(CASE WHEN ${PENDING_SNOOZE} THEN 1 ELSE 0 END) AS snoozed
       FROM threads t WHERE ${NOT_JUNK} ${scope}`
    )
    .get(...args) as { inbox: number | null; unread: number | null; snoozed: number | null };
  const queues = queueCounts(db, accountIds);
  const cleared = clearedCounts(db, accountIds);
  return { inbox: row.inbox ?? 0, unread: row.unread ?? 0, snoozed: row.snoozed ?? 0, ...queues, clearedDaily: cleared.daily, clearedWeekly: cleared.weekly };
}

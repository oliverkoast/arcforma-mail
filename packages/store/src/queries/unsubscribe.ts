// What U needs from the store: the List-Unsubscribe headers of the newest
// inbound message in a thread, and the per-thread record of what running them
// did. The headers themselves are parsed in the gmail package; this file only
// finds and remembers.

import type { Db } from "../db.js";

export type UnsubscribeState = "none" | "sent" | "opened" | "failed";
export type UnsubscribeMethod = "one-click" | "mailto" | "open";

export interface UnsubscribeRow {
  account_id: string;
  thread_id: string;
  state: UnsubscribeState;
  method: UnsubscribeMethod | null;
  target: string | null;
  error: string | null;
  updated_at: number;
}

/** The thread's unsubscribe state as a scalar subquery against alias t; NULL when U never ran on it. */
export const UNSUBSCRIBE_STATE = "(SELECT u.state FROM thread_unsubscribes u WHERE u.account_id = t.account_id AND u.thread_id = t.id)";

/** True when any inbound message in the thread carries a List-Unsubscribe header, so the list can offer U. */
export const CAN_UNSUBSCRIBE = `EXISTS (SELECT 1 FROM messages m WHERE m.account_id = t.account_id AND m.thread_id = t.id AND m.direction = 'in' AND m.headers_json LIKE '%"List-Unsubscribe"%')`;

/** The newest inbound message with a List-Unsubscribe header, plus who it came from. */
export interface UnsubscribeSource {
  messageId: string;
  fromEmail: string;
  fromName: string;
  listUnsubscribe: string;
  listUnsubscribePost: string | null;
  listId: string | null;
}

export function unsubscribeSource(db: Db, accountId: string, threadId: string): UnsubscribeSource | null {
  const rows = db
    .prepare(
      `SELECT id, from_email, from_name, headers_json FROM messages
       WHERE account_id = ? AND thread_id = ? AND direction = 'in' AND headers_json LIKE '%"List-Unsubscribe"%'
       ORDER BY internal_date DESC, id DESC`
    )
    .all(accountId, threadId) as Array<{ id: string; from_email: string; from_name: string; headers_json: string }>;
  for (const r of rows) {
    let headers: Record<string, string>;
    try {
      headers = JSON.parse(r.headers_json) as Record<string, string>;
    } catch {
      continue;
    }
    const listUnsubscribe = headers["List-Unsubscribe"]?.trim();
    if (!listUnsubscribe) continue;
    return {
      messageId: r.id,
      fromEmail: r.from_email,
      fromName: r.from_name,
      listUnsubscribe,
      listUnsubscribePost: headers["List-Unsubscribe-Post"]?.trim() || null,
      listId: headers["List-Id"]?.trim() || null,
    };
  }
  return null;
}

export function getUnsubscribeState(db: Db, accountId: string, threadId: string): UnsubscribeRow | null {
  return (db.prepare("SELECT * FROM thread_unsubscribes WHERE account_id = ? AND thread_id = ?").get(accountId, threadId) as unknown as UnsubscribeRow | undefined) ?? null;
}

export function setUnsubscribeState(
  db: Db,
  accountId: string,
  threadId: string,
  input: { state: UnsubscribeState; method?: UnsubscribeMethod | null; target?: string | null; error?: string | null },
  now = Date.now()
): void {
  db.prepare(
    `INSERT INTO thread_unsubscribes (account_id, thread_id, state, method, target, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, thread_id) DO UPDATE SET state = excluded.state, method = excluded.method, target = excluded.target, error = excluded.error, updated_at = excluded.updated_at`
  ).run(accountId, threadId, input.state, input.method ?? null, input.target ?? null, input.error ?? null, now);
}

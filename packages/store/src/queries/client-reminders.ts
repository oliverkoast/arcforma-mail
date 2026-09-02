// The default reminder rule for client mail. A message sent into a thread that
// is filed under a category in the scope (Clients by default), or to anyone
// with a two-way history in such a thread, gets a remind-if-no-reply so it
// resurfaces with the NO REPLY BY eyebrow after N days. The scheduler applies
// it when a send succeeds; this file answers "does it apply".

import type { Db } from "../db.js";
import { placeholders } from "../db.js";
import { TO_OR_CC } from "./contacts.js";

/** Category ids and builtin type ids the scope names, matched case-insensitively on id or name. */
export function scopedCategoryIds(db: Db, scope: string[]): string[] {
  const wanted = new Set(scope.map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) return [];
  const rows = db.prepare("SELECT id, name FROM categories").all() as Array<{ id: string; name: string }>;
  const out = new Set<string>();
  for (const r of rows) {
    if (wanted.has(r.id.toLowerCase()) || wanted.has(r.name.toLowerCase())) out.add(r.id);
  }
  // A scope entry that is not a category row still matches a classification type or id by name.
  for (const w of wanted) out.add(w);
  return Array.from(out);
}

function categoryMatch(ids: string[]): string {
  const ph = placeholders(ids.length);
  return `(lower(COALESCE(c.category_id, '')) IN (${ph}) OR lower(COALESCE(c.type, '')) IN (${ph}))`;
}

/** True when the thread is classified under one of the categories. */
export function threadInCategories(db: Db, accountId: string, threadId: string, ids: string[]): boolean {
  if (ids.length === 0) return false;
  const lower = ids.map((i) => i.toLowerCase());
  const row = db
    .prepare(`SELECT 1 FROM classifications c WHERE c.account_id = ? AND c.thread_id = ? AND ${categoryMatch(lower)} LIMIT 1`)
    .get(accountId, threadId, ...lower, ...lower);
  return Boolean(row);
}

/** True when the address wrote to us and we wrote back in at least one thread filed under the categories, across accounts. */
export function twoWayInCategories(db: Db, email: string, ids: string[]): boolean {
  if (ids.length === 0) return false;
  const e = email.toLowerCase();
  const lower = ids.map((i) => i.toLowerCase());
  const row = db
    .prepare(
      `SELECT 1 FROM threads t
       JOIN classifications c ON c.account_id = t.account_id AND c.thread_id = t.id
       WHERE ${categoryMatch(lower)}
         AND EXISTS (SELECT 1 FROM messages m WHERE m.account_id = t.account_id AND m.thread_id = t.id AND m.direction = 'in' AND lower(m.from_email) = ?)
         AND EXISTS (SELECT 1 FROM messages m WHERE m.account_id = t.account_id AND m.thread_id = t.id AND m.direction = 'out' AND ${TO_OR_CC})
       LIMIT 1`
    )
    .get(...lower, ...lower, e, e, e);
  return Boolean(row);
}

export interface ClientReminderInput {
  accountId: string;
  /** The thread the message was sent into, when it was a reply. */
  threadId: string | null;
  /** Lowercased recipient addresses, the sender's own addresses already removed. */
  recipients: string[];
  /** Category ids or names, from the remindScope setting. */
  scope: string[];
}

/** The rule: the thread is in scope, or any recipient has a two-way history in a thread that is. */
export function clientReminderApplies(db: Db, input: ClientReminderInput): boolean {
  const ids = scopedCategoryIds(db, input.scope);
  if (ids.length === 0) return false;
  if (input.threadId && threadInCategories(db, input.accountId, input.threadId, ids)) return true;
  return input.recipients.some((r) => twoWayInCategories(db, r, ids));
}

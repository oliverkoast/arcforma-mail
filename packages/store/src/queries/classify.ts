// Queries the classifier and the corrections bank need: which threads still
// want a verdict, which sender domains Oliver has replied to, the nearest
// corrections for few-shot, the instant-reply cache, and snippet edits.

import type { Db } from "../db.js";
import { placeholders } from "../db.js";
import type { ClassificationRow, CorrectionRow, ThreadRow } from "../types.js";

const DAY = 86_400_000;

export function getClassification(db: Db, accountId: string, threadId: string): ClassificationRow | null {
  return (db.prepare("SELECT * FROM classifications WHERE account_id = ? AND thread_id = ?").get(accountId, threadId) as unknown as ClassificationRow | undefined) ?? null;
}

/**
 * Threads that have no classification, or whose last message changed since
 * they were classified. Newest first so the visible inbox settles first.
 */
export function threadsNeedingClassification(db: Db, opts: { limit?: number; sinceDays?: number; accountIds?: string[] } = {}): ThreadRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 2000);
  const since = Date.now() - (opts.sinceDays ?? 90) * DAY;
  const scope = opts.accountIds && opts.accountIds.length ? `AND t.account_id IN (${placeholders(opts.accountIds.length)})` : "";
  return db
    .prepare(
      `SELECT t.* FROM threads t
       LEFT JOIN classifications c ON c.account_id = t.account_id AND c.thread_id = t.id
       WHERE t.last_message_at >= ? ${scope}
         AND (c.thread_id IS NULL OR c.source != 'manual' AND c.last_message_id IS NOT
           (SELECT m.id FROM messages m WHERE m.account_id = t.account_id AND m.thread_id = t.id ORDER BY m.internal_date DESC, m.id DESC LIMIT 1))
       ORDER BY t.sort_at DESC LIMIT ?`
    )
    .all(since, ...(opts.accountIds ?? []), limit) as unknown as ThreadRow[];
}

/** Threads active in the last N days, for a background reclassify after a category is added. */
export function recentThreads(db: Db, days: number, limit = 2000): ThreadRow[] {
  return db.prepare("SELECT * FROM threads WHERE last_message_at >= ? ORDER BY sort_at DESC LIMIT ?").all(Date.now() - days * DAY, limit) as unknown as ThreadRow[];
}

/** Every address and domain Oliver sent to in the window, lowercased. One scan, because both are read together. */
export function repliedTo(db: Db, days = 90): { addresses: Set<string>; domains: Set<string> } {
  const rows = db.prepare("SELECT to_json, cc_json FROM messages WHERE direction = 'out' AND internal_date >= ?").all(Date.now() - days * DAY) as Array<{ to_json: string; cc_json: string }>;
  const addresses = new Set<string>();
  const domains = new Set<string>();
  for (const r of rows) {
    for (const list of [r.to_json, r.cc_json]) {
      try {
        for (const a of JSON.parse(list) as Array<{ email: string }>) {
          const email = a.email.toLowerCase();
          if (!email) continue;
          addresses.add(email);
          const d = email.split("@")[1];
          if (d) domains.add(d);
        }
      } catch {
        // A malformed row cannot make a domain important.
      }
    }
  }
  return { addresses, domains };
}

/** Lowercased domains of every recipient Oliver sent to in the window. */
export function repliedDomains(db: Db, days = 90): Set<string> {
  return repliedTo(db, days).domains;
}

/** Lowercased addresses Oliver sent to in the window. Writing to an address is the strongest sign it belongs to a person. */
export function repliedAddresses(db: Db, days = 90): Set<string> {
  return repliedTo(db, days).addresses;
}

export function listCorrections(db: Db, limit = 500): CorrectionRow[] {
  return db.prepare("SELECT * FROM corrections ORDER BY id DESC LIMIT ?").all(limit) as unknown as CorrectionRow[];
}

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "at", "is", "it", "this", "that", "with", "from", "re", "fwd", "you", "your", "we", "our", "i"]);

export function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9@.]+/)
      .filter((t) => t.length > 2 && !STOP.has(t))
  );
}

/** Jaccard similarity over word sets, with a bonus for a shared sender address. */
export function similarity(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const jaccard = inter / (sa.size + sb.size - inter);
  const senderA = /from:\s*(\S+@\S+)/i.exec(a)?.[1];
  const senderB = /from:\s*(\S+@\S+)/i.exec(b)?.[1];
  return jaccard + (senderA && senderA === senderB ? 0.5 : 0);
}

/** The k corrections whose excerpt reads most like the text, most similar first; ties go to the newest. */
export function nearestCorrections(db: Db, text: string, k = 8): CorrectionRow[] {
  const all = listCorrections(db, 500);
  return all
    .map((c, i) => ({ c, score: similarity(text, c.text_excerpt), i }))
    .sort((x, y) => y.score - x.score || x.i - y.i)
    .slice(0, k)
    .map((x) => x.c);
}

// ---- instant replies cache ----------------------------------------------------

export function getReplyOptions(db: Db, accountId: string, messageId: string): string[] | null {
  const row = db.prepare("SELECT replies_json FROM reply_options WHERE account_id = ? AND message_id = ?").get(accountId, messageId) as { replies_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.replies_json) as string[];
  } catch {
    return null;
  }
}

export function setReplyOptions(db: Db, accountId: string, messageId: string, replies: string[]): void {
  db.prepare("INSERT INTO reply_options (account_id, message_id, replies_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, message_id) DO UPDATE SET replies_json = excluded.replies_json, created_at = excluded.created_at").run(
    accountId,
    messageId,
    JSON.stringify(replies),
    Date.now()
  );
}

// ---- snippets and categories, edits -----------------------------------------------

export function deleteSnippet(db: Db, id: number): void {
  db.prepare("DELETE FROM snippets WHERE id = ?").run(id);
}

export function updateSnippet(db: Db, id: number, s: { trigger: string; name: string; bodyHtml: string; bodyText: string }): void {
  db.prepare("UPDATE snippets SET trigger = ?, name = ?, body_html = ?, body_text = ?, updated_at = ? WHERE id = ?").run(s.trigger, s.name, s.bodyHtml, s.bodyText, Date.now(), id);
}

export function updateCategory(db: Db, id: string, patch: { name?: string; prompt?: string }): void {
  if (patch.name !== undefined) db.prepare("UPDATE categories SET name = ? WHERE id = ? AND kind = 'custom'").run(patch.name, id);
  if (patch.prompt !== undefined) db.prepare("UPDATE categories SET prompt = ? WHERE id = ?").run(patch.prompt, id);
}

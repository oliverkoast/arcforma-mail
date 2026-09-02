import type { Db } from "../db.js";
import { placeholders } from "../db.js";
import type { ThreadListRow } from "../types.js";

export interface SearchHit {
  row: ThreadListRow;
  messageId: string;
  excerpt: string;
  rank: number;
}

/** Turns free text into an FTS5 query: each token quoted, prefix-matched, implicit AND. */
export function toFtsQuery(input: string): string {
  const tokens = input
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter(Boolean);
  return tokens.map((t) => `"${t}"*`).join(" ");
}

/** Full-text search over subject, sender, recipients, and body. One hit per thread, best rank first. */
export function search(db: Db, query: string, opts: { accountIds?: string[]; limit?: number } = {}): SearchHit[] {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
  const scope = opts.accountIds && opts.accountIds.length ? `AND f.account_id IN (${placeholders(opts.accountIds.length)})` : "";
  const args: Array<string | number> = [fts];
  if (opts.accountIds && opts.accountIds.length) args.push(...opts.accountIds);
  const hits = db
    .prepare(
      `SELECT f.account_id, f.thread_id, f.message_id, bm25(messages_fts) AS rank, snippet(messages_fts, 6, '', '', ' ', 14) AS excerpt
       FROM messages_fts f WHERE messages_fts MATCH ? ${scope} ORDER BY rank LIMIT ?`
    )
    .all(...args, limit * 3) as Array<{ account_id: string; thread_id: string; message_id: string; rank: number; excerpt: string }>;
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  const threadStmt = db.prepare(
    `SELECT t.*, c.split, c.type, c.category_id, NULL AS wake_at, NULL AS no_reply_by FROM threads t
     LEFT JOIN classifications c ON c.account_id = t.account_id AND c.thread_id = t.id
     WHERE t.account_id = ? AND t.id = ?`
  );
  for (const h of hits) {
    const key = `${h.account_id}:${h.thread_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = threadStmt.get(h.account_id, h.thread_id) as unknown as ThreadListRow | undefined;
    if (!row) continue;
    out.push({ row, messageId: h.message_id, excerpt: h.excerpt, rank: h.rank });
    if (out.length >= limit) break;
  }
  return out;
}

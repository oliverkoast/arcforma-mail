// Search over the local store. The query syntax lives in searchQuery.ts; this
// file runs the compiled form: an FTS5 MATCH over messages_fts joined back to
// messages and threads for the SQL predicates, or the predicates alone when
// the query has no words. One hit per thread, best rank first (newest first
// when there is nothing to rank), with the matched text marked for the list.

import type { Db } from "../db.js";
import { getSetting } from "./settings.js";
import { QUEUE_JOIN } from "./queues.js";
import { HIGHLIGHT_END, HIGHLIGHT_START, compileSearch, isEmptySearch, parseSearchQuery, toFtsMatch, type CompiledSearch, type ParsedSearch } from "./searchQuery.js";
import { CAN_UNSUBSCRIBE, UNSUBSCRIBE_STATE } from "./unsubscribe.js";
import type { ThreadListRow } from "../types.js";

export type HighlightField = "subject" | "from" | "to" | "body";

/** The matched text of the best field, with HIGHLIGHT_START and HIGHLIGHT_END around each hit term. */
export interface SearchHighlight {
  /** Which indexed field the shown text came from; null when the query had no words to mark. */
  field: HighlightField | null;
  text: string;
}

export interface SearchHit {
  row: ThreadListRow;
  messageId: string;
  /** Plain body words around the match, unmarked. Ask AI reads this. */
  excerpt: string;
  rank: number;
  highlight: SearchHighlight;
}

/**
 * Turns free text into an FTS5 query: each token quoted, prefix-matched,
 * implicit AND. Kept for callers that want the words only; search() itself
 * goes through parseSearchQuery so operators work.
 */
export function toFtsQuery(input: string): string {
  return toFtsMatch(parseSearchQuery(input)) ?? "";
}

interface RawHit {
  account_id: string;
  thread_id: string;
  message_id: string;
  rank: number;
  excerpt: string;
  h_subject: string | null;
  h_from: string | null;
  h_to: string | null;
  h_body: string | null;
}

const JOINS = `JOIN threads t ON t.account_id = m.account_id AND t.id = m.thread_id
     LEFT JOIN classifications c ON c.account_id = t.account_id AND c.thread_id = t.id
     ${QUEUE_JOIN}`;

/** The FROM clause: through the FTS index when there are words, straight over messages when there are not. */
function fromClause(compiled: CompiledSearch, withHighlights: boolean): { sql: string; args: Array<string | number>; order: string } {
  if (compiled.fts) {
    const hl = withHighlights
      ? `, snippet(messages_fts, 3, '${HIGHLIGHT_START}', '${HIGHLIGHT_END}', '', 12) AS h_subject,
           snippet(messages_fts, 4, '${HIGHLIGHT_START}', '${HIGHLIGHT_END}', '', 12) AS h_from,
           snippet(messages_fts, 5, '${HIGHLIGHT_START}', '${HIGHLIGHT_END}', '', 12) AS h_to,
           snippet(messages_fts, 6, '${HIGHLIGHT_START}', '${HIGHLIGHT_END}', ' ', 14) AS h_body,
           snippet(messages_fts, 6, '', '', ' ', 14) AS excerpt`
      : "";
    return {
      sql: `FROM (SELECT rowid AS fts_rowid, bm25(messages_fts) AS rank${hl} FROM messages_fts WHERE messages_fts MATCH ?) f
            JOIN messages m ON m.fts_id = f.fts_rowid
            ${JOINS}`,
      args: [compiled.fts],
      // Newest first, always. bm25 relevance used to lead, which scattered the results by date:
      // an August thread above one from July above one from yesterday, with no visible reason for
      // the order. In mail, recency is the relevance, and a list you cannot scan by date is a list
      // you have to read all of. rank stays only to settle threads from the same instant.
      order: "m.internal_date DESC, f.rank",
    };
  }
  return { sql: `FROM messages m ${JOINS}`, args: [], order: "m.internal_date DESC" };
}

function pickHighlight(h: RawHit): SearchHighlight {
  const marked = (s: string | null) => Boolean(s && s.includes(HIGHLIGHT_START));
  if (marked(h.h_subject)) return { field: "subject", text: h.h_subject! };
  if (marked(h.h_from)) return { field: "from", text: h.h_from! };
  if (marked(h.h_to)) return { field: "to", text: h.h_to! };
  if (marked(h.h_body)) return { field: "body", text: h.h_body! };
  return { field: null, text: h.excerpt };
}

/** Full-text search with operators. One hit per thread, best rank first. */
export function search(db: Db, query: string, opts: { accountIds?: string[]; limit?: number; now?: number } = {}): SearchHit[] {
  const parsed = parseSearchQuery(query);
  if (isEmptySearch(parsed)) return [];
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
  const compiled = compileSearch(parsed, { now: opts.now, dayStartAt: getSetting(db, "dayStartAt"), accountIds: opts.accountIds });
  const from = fromClause(compiled, true);
  const select = compiled.fts
    ? "m.account_id, m.thread_id, m.id AS message_id, f.rank, f.excerpt, f.h_subject, f.h_from, f.h_to, f.h_body"
    : "m.account_id, m.thread_id, m.id AS message_id, 0 AS rank, m.snippet AS excerpt, NULL AS h_subject, NULL AS h_from, NULL AS h_to, NULL AS h_body";
  const hits = db
    .prepare(`SELECT ${select} ${from.sql} WHERE ${compiled.where.join(" AND ")} ORDER BY ${from.order} LIMIT ?`)
    .all(...from.args, ...compiled.args, limit * 3) as unknown as RawHit[];
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  const threadStmt = db.prepare(
    `SELECT t.*, c.split, c.type, c.category_id, NULL AS wake_at, NULL AS no_reply_by, NULL AS queue,
       ${UNSUBSCRIBE_STATE} AS unsubscribe_state, ${CAN_UNSUBSCRIBE} AS can_unsubscribe
     FROM threads t
     LEFT JOIN classifications c ON c.account_id = t.account_id AND c.thread_id = t.id
     WHERE t.account_id = ? AND t.id = ?`
  );
  for (const h of hits) {
    const key = `${h.account_id}:${h.thread_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = threadStmt.get(h.account_id, h.thread_id) as unknown as ThreadListRow | undefined;
    if (!row) continue;
    out.push({ row, messageId: h.message_id, excerpt: h.excerpt, rank: h.rank, highlight: pickHighlight(h) });
    if (out.length >= limit) break;
  }
  return out;
}

/** Threads a query matches, counted the way search() would list them. */
export function searchCount(db: Db, query: string, opts: { accountIds?: string[]; now?: number } = {}): number {
  const parsed = parseSearchQuery(query);
  if (isEmptySearch(parsed)) return 0;
  const compiled = compileSearch(parsed, { now: opts.now, dayStartAt: getSetting(db, "dayStartAt"), accountIds: opts.accountIds });
  const from = fromClause(compiled, false);
  const row = db
    .prepare(`SELECT COUNT(DISTINCT m.account_id || ':' || m.thread_id) AS n ${from.sql} WHERE ${compiled.where.join(" AND ")}`)
    .get(...from.args, ...compiled.args) as { n: number };
  return row.n;
}

/** A query is usable when it asks for anything at all; the parse is exposed so the UI can show what was ignored. */
export function describeSearch(query: string): { parsed: ParsedSearch; empty: boolean } {
  const parsed = parseSearchQuery(query);
  return { parsed, empty: isEmptySearch(parsed) };
}

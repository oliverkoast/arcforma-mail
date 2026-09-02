// What the configurable sidebar reads and writes: saved searches, the stored
// row layout, the queued send-later rows the Scheduled view lists, and one
// query that returns every row count at once so the sidebar refreshes in a
// single round trip.

import type { Db } from "../db.js";
import { placeholders } from "../db.js";
import { HAS_LABEL, NOT_JUNK, PENDING_SNOOZE } from "./fragments.js";
import { toFtsQuery } from "./search.js";
import { threadCounts, type ThreadCounts } from "./threads.js";
import type { SavedSearchRow, SendQueueRow } from "../types.js";

// ---- saved searches ----------------------------------------------------------

export function listSavedSearches(db: Db): SavedSearchRow[] {
  return db.prepare("SELECT * FROM saved_searches ORDER BY position, id").all() as unknown as SavedSearchRow[];
}

export function getSavedSearch(db: Db, id: number): SavedSearchRow | null {
  return (db.prepare("SELECT * FROM saved_searches WHERE id = ?").get(id) as unknown as SavedSearchRow | undefined) ?? null;
}

export function createSavedSearch(db: Db, input: { name: string; query: string }): SavedSearchRow {
  const name = input.name.trim();
  const query = input.query.trim();
  if (!name) throw new Error("Give the saved search a name.");
  if (!toFtsQuery(query)) throw new Error("Give the saved search something to look for.");
  const now = Date.now();
  const pos = (db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM saved_searches").get() as { p: number }).p;
  const res = db.prepare("INSERT INTO saved_searches (name, query, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(name, query, pos, now, now);
  return getSavedSearch(db, Number(res.lastInsertRowid))!;
}

export function updateSavedSearch(db: Db, id: number, patch: { name?: string; query?: string }): SavedSearchRow | null {
  const row = getSavedSearch(db, id);
  if (!row) return null;
  const name = patch.name === undefined ? row.name : patch.name.trim();
  const query = patch.query === undefined ? row.query : patch.query.trim();
  if (!name) throw new Error("Give the saved search a name.");
  if (!toFtsQuery(query)) throw new Error("Give the saved search something to look for.");
  db.prepare("UPDATE saved_searches SET name = ?, query = ?, updated_at = ? WHERE id = ?").run(name, query, Date.now(), id);
  return getSavedSearch(db, id);
}

export function deleteSavedSearch(db: Db, id: number): boolean {
  return Number(db.prepare("DELETE FROM saved_searches WHERE id = ?").run(id).changes) === 1;
}

/** Threads a query matches, counted the way the search list would list them: one per thread, junk excluded. */
export function savedSearchCount(db: Db, query: string, accountIds?: string[]): number {
  const fts = toFtsQuery(query);
  if (!fts) return 0;
  const scope = accountIds && accountIds.length ? `AND f.account_id IN (${placeholders(accountIds.length)})` : "";
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM threads t
       WHERE ${NOT_JUNK} AND EXISTS (
         SELECT 1 FROM messages_fts f WHERE messages_fts MATCH ? AND f.account_id = t.account_id AND f.thread_id = t.id ${scope}
       )`
    )
    .get(fts, ...(accountIds ?? [])) as { n: number };
  return row.n;
}

// ---- sidebar layout ------------------------------------------------------------

const LAYOUT_KEY = "sidebarLayout";

/** The stored layout as parsed JSON, or null when nothing has been saved yet. The renderer owns the shape. */
export function getSidebarLayout(db: Db): unknown {
  const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(LAYOUT_KEY) as { value_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as unknown;
  } catch {
    return null;
  }
}

export function setSidebarLayout(db: Db, layout: unknown): void {
  db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at").run(
    LAYOUT_KEY,
    JSON.stringify(layout ?? null),
    Date.now()
  );
}

// ---- scheduled sends -----------------------------------------------------------

/** Queued send_queue rows still in the future: what Send later put there, soonest first. */
export function listScheduledSends(db: Db, accountIds?: string[], now = Date.now()): SendQueueRow[] {
  const scope = accountIds && accountIds.length ? `AND account_id IN (${placeholders(accountIds.length)})` : "";
  return db.prepare(`SELECT * FROM send_queue WHERE status = 'queued' AND send_at > ? ${scope} ORDER BY send_at, id`).all(now, ...(accountIds ?? [])) as unknown as SendQueueRow[];
}

// ---- every sidebar count at once ----------------------------------------------------

export interface SidebarCounts extends ThreadCounts {
  attachments: number;
  archive: number;
  spam: number;
  trash: number;
  starred: number;
  scheduled: number;
  important: number;
  other: number;
  /** Inbox threads per builtin type and custom category id. */
  categories: Record<string, number>;
  /** Matching threads per saved search id. */
  searches: Record<string, number>;
}

export function sidebarCounts(db: Db, accountIds?: string[], now = Date.now()): SidebarCounts {
  const base = threadCounts(db, accountIds);
  const scoped = accountIds && accountIds.length ? accountIds : [];
  const scope = scoped.length ? `AND t.account_id IN (${placeholders(scoped.length)})` : "";
  const folders = db
    .prepare(
      `SELECT
         SUM(CASE WHEN ${NOT_JUNK} AND t.has_attachments = 1 THEN 1 ELSE 0 END) AS attachments,
         SUM(CASE WHEN ${NOT_JUNK} AND t.in_inbox = 0 AND NOT ${PENDING_SNOOZE} THEN 1 ELSE 0 END) AS archive,
         SUM(CASE WHEN ${HAS_LABEL("SPAM")} THEN 1 ELSE 0 END) AS spam,
         SUM(CASE WHEN ${HAS_LABEL("TRASH")} THEN 1 ELSE 0 END) AS trash,
         SUM(CASE WHEN ${NOT_JUNK} AND t.starred = 1 THEN 1 ELSE 0 END) AS starred
       FROM threads t WHERE 1 = 1 ${scope}`
    )
    .get(...scoped) as { attachments: number | null; archive: number | null; spam: number | null; trash: number | null; starred: number | null };
  const groups = db
    .prepare(
      `SELECT c.split, c.type, c.category_id, COUNT(*) AS n FROM threads t
       LEFT JOIN classifications c ON c.account_id = t.account_id AND c.thread_id = t.id
       WHERE ${NOT_JUNK} AND t.in_inbox = 1 AND NOT ${PENDING_SNOOZE} ${scope}
       GROUP BY c.split, c.type, c.category_id`
    )
    .all(...scoped) as Array<{ split: string | null; type: string | null; category_id: string | null; n: number }>;
  const categories: Record<string, number> = {};
  let important = 0;
  let other = 0;
  for (const g of groups) {
    if (g.split === "important") important += g.n;
    else other += g.n;
    if (g.type) categories[g.type] = (categories[g.type] ?? 0) + g.n;
    if (g.category_id) categories[g.category_id] = (categories[g.category_id] ?? 0) + g.n;
  }
  const searches: Record<string, number> = {};
  for (const s of listSavedSearches(db)) searches[String(s.id)] = savedSearchCount(db, s.query, accountIds);
  const sendScope = scoped.length ? `AND account_id IN (${placeholders(scoped.length)})` : "";
  const scheduled = (db.prepare(`SELECT COUNT(*) AS n FROM send_queue WHERE status = 'queued' AND send_at > ? ${sendScope}`).get(now, ...scoped) as { n: number }).n;
  return {
    ...base,
    attachments: folders.attachments ?? 0,
    archive: folders.archive ?? 0,
    spam: folders.spam ?? 0,
    trash: folders.trash ?? 0,
    starred: folders.starred ?? 0,
    scheduled,
    important,
    other,
    categories,
    searches,
  };
}

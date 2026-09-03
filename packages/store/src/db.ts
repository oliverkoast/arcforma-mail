import { recomputeThread } from "./queries/messages.js";
import { decodeEntities } from "./mail-headers.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { reindexAllMessages } from "./queries/messages.js";

export type Db = DatabaseSync;

const SCHEMA_VERSION = 15;

// Version 2: local drafts (Esc keeps the compose), app settings, and the
// instant-reply cache keyed by message id.
const MIGRATION_2 = `
CREATE TABLE IF NOT EXISTS drafts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id        TEXT NOT NULL,
  thread_id         TEXT,
  mode              TEXT NOT NULL DEFAULT 'new',
  to_json           TEXT NOT NULL DEFAULT '[]',
  cc_json           TEXT NOT NULL DEFAULT '[]',
  bcc_json          TEXT NOT NULL DEFAULT '[]',
  subject           TEXT NOT NULL DEFAULT '',
  body_html         TEXT NOT NULL DEFAULT '',
  quoted_html       TEXT NOT NULL DEFAULT '',
  in_reply_to       TEXT,
  references_header TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS drafts_updated ON drafts(updated_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reply_options (
  account_id   TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  replies_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (account_id, message_id)
);
`;

// Version 3: a stable integer key for the FTS index. messages has a TEXT
// composite primary key, so its implicit rowid is not stable: VACUUM may
// renumber it, and messages_fts rows keyed by that rowid would then point at
// the wrong message on the next re-index. fts_id is assigned once per row and
// never changes. Existing rows take their current rowid, which is what the
// FTS rows were keyed by, and the index is rebuilt from scratch afterwards
// so no row can be left pointing the wrong way.
const MIGRATION_3 = `
ALTER TABLE messages ADD COLUMN fts_id INTEGER;
UPDATE messages SET fts_id = rowid WHERE fts_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS messages_fts_id ON messages(fts_id);
`;

// Version 5: Daily 0, Weekly 0, and Later. queue_items holds the stored
// choices (D, W, a snooze wake, a reminder, a rollover); the automatic part of
// Daily 0 is computed live in queries/queues.ts. queue_clears logs every E so
// the empty state can say how many were cleared today.
const MIGRATION_5 = `
CREATE TABLE IF NOT EXISTS queue_items (
  account_id TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  queue      TEXT NOT NULL,
  added_at   INTEGER NOT NULL,
  source     TEXT NOT NULL DEFAULT 'user',
  PRIMARY KEY (account_id, thread_id),
  FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS queue_items_queue ON queue_items(queue, added_at);

CREATE TABLE IF NOT EXISTS queue_clears (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  queue      TEXT NOT NULL,
  cleared_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS queue_clears_at ON queue_clears(queue, cleared_at);
`;

// Version 6: saved searches for the sidebar. A row is a name and a query in
// the same syntax the / search takes; the list view runs it through FTS.
const MIGRATION_6 = `
CREATE TABLE IF NOT EXISTS saved_searches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  query      TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

// Version 7: drafts mirror to Gmail. gmail_draft_id and gmail_message_id tie
// a local row to users.drafts; mirror_state says whether the last local edit
// has reached Gmail; origin records whether the draft was written here or
// found in Gmail; local_edited_at is the last edit made in this app, which is
// what decides a conflict with an edit made in Gmail.
const MIGRATION_7_COLUMNS: Array<[string, string]> = [
  ["gmail_draft_id", "TEXT"],
  ["gmail_message_id", "TEXT"],
  ["mirror_state", "TEXT NOT NULL DEFAULT 'pending'"],
  ["mirror_error", "TEXT"],
  ["mirrored_at", "INTEGER"],
  ["origin", "TEXT NOT NULL DEFAULT 'local'"],
  ["local_edited_at", "INTEGER"],
];

/** ALTER TABLE ADD COLUMN has no IF NOT EXISTS, so each column is checked first; the step can then rerun like the others. */
function migrateDraftsMirror(db: Db): void {
  const have = new Set((db.prepare("PRAGMA table_info(drafts)").all() as Array<{ name: string }>).map((c) => c.name));
  for (const [name, type] of MIGRATION_7_COLUMNS) {
    if (!have.has(name)) db.exec(`ALTER TABLE drafts ADD COLUMN ${name} ${type}`);
  }
  db.exec("UPDATE drafts SET local_edited_at = updated_at WHERE local_edited_at IS NULL");
  db.exec("CREATE INDEX IF NOT EXISTS drafts_gmail ON drafts(account_id, gmail_draft_id)");
}

// Version 8: what U did to a thread. One row per thread the user unsubscribed
// from: the method that ran (one-click POST, a mailto message, or the page
// opened in the browser), where it went, and whether it worked, so the list
// can read UNSUBSCRIBED and a second press does not send twice.
const MIGRATION_8 = `
CREATE TABLE IF NOT EXISTS thread_unsubscribes (
  account_id TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'none',
  method     TEXT,
  target     TEXT,
  error      TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, thread_id)
);
`;

// Version 11: mailbox sorting gained Promotions and Jobs. The seed in schema.sql
// only runs for a new store, so an existing one gets the two rows here, and the
// builtin positions are restated so the sidebar lists them in the same order
// everywhere: Newsletters, Promotions, Jobs, Calendar, Notifications, Receipts.
const MIGRATION_11 = `
INSERT OR IGNORE INTO categories (id, name, kind, prompt, gmail_label, position, created_at) VALUES
  ('promotions', 'Promotions', 'builtin', 'Marketing, offers, product upsell, events, and sales.', 'Arcforma/Promotions', 2, 0),
  ('jobs',       'Jobs',       'builtin', 'Applicants, applications, candidate alerts, and recruiter mail.', 'Arcforma/Jobs', 3, 0);
UPDATE categories SET position = 1, prompt = 'Editorial or recurring publication content you subscribed to.' WHERE id = 'newsletters';
UPDATE categories SET position = 4 WHERE id = 'calendar';
UPDATE categories SET position = 5, prompt = 'Transactional or platform alerts reporting something that happened.' WHERE id = 'notifications';
UPDATE categories SET position = 6 WHERE id = 'receipts';
`;

// Version 12: the attention model. Every classification gains a 0 to 100 score,
// the band it lands in, and the sentence that explains it. split is untouched,
// so every query written before this still reads the same column; needs_you and
// important both file as important there. Existing rows start at band 'other'
// with a score of 0, and the classifier's attention sweep fills them in on the
// next start.
const MIGRATION_12_COLUMNS: Array<[string, string]> = [
  ["attention", "INTEGER NOT NULL DEFAULT 0"],
  ["band", "TEXT NOT NULL DEFAULT 'other'"],
  ["reason", "TEXT"],
];

/** ALTER TABLE ADD COLUMN has no IF NOT EXISTS, so each column is checked first; the step can then rerun like the others. */
function migrateAttention(db: Db): void {
  const have = new Set((db.prepare("PRAGMA table_info(classifications)").all() as Array<{ name: string }>).map((c) => c.name));
  for (const [name, type] of MIGRATION_12_COLUMNS) {
    if (!have.has(name)) db.exec(`ALTER TABLE classifications ADD COLUMN ${name} ${type}`);
  }
  // An existing important row keeps its split until the sweep re-decides it, so the band starts where the split is.
  db.exec("UPDATE classifications SET band = 'important' WHERE split = 'important' AND band = 'other'");
  db.exec("CREATE INDEX IF NOT EXISTS classifications_band ON classifications(band, attention DESC)");
}

// Version 13: attachment bytes cached on disk. One row per cached attachment,
// keyed by the message and the part, recording the sanitised filename, the mime
// type, the byte count, and the path the bytes are at. A second open of the
// same attachment reads the file instead of asking Gmail again.
//
// Deleting the message must not leave the file behind. The foreign key takes
// the row when its message goes (and messages themselves cascade from threads,
// and threads from accounts), and the AFTER DELETE trigger copies the path into
// orphan_attachments on the way out, whichever of those paths the delete came
// down. openStore turns recursive_triggers on so the trigger also fires for the
// cascaded deletes, not only for a direct one. The app drains that table and
// unlinks the files, confining every path to the attachments folder first.
const MIGRATION_13 = `
CREATE TABLE IF NOT EXISTS attachment_files (
  account_id     TEXT NOT NULL,
  message_id     TEXT NOT NULL,
  attachment_key TEXT NOT NULL,
  filename       TEXT NOT NULL,
  mime_type      TEXT NOT NULL DEFAULT 'application/octet-stream',
  bytes          INTEGER NOT NULL DEFAULT 0,
  path           TEXT NOT NULL,
  cached_at      INTEGER NOT NULL,
  PRIMARY KEY (account_id, message_id, attachment_key),
  FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS attachment_files_message ON attachment_files(account_id, message_id);

CREATE TABLE IF NOT EXISTS orphan_attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT NOT NULL,
  orphaned_at INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS attachment_files_orphan AFTER DELETE ON attachment_files
BEGIN
  INSERT INTO orphan_attachments (path, orphaned_at)
  VALUES (OLD.path, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;
`;

// Version 15: read receipts. One row per message a sender armed, keyed by the
// 32 hex token the image URL carries, plus one row per fetch the pixel service
// reported. Nothing here says a person read anything: an event records that
// software asked for an image, and classify.mjs in packages/pixel-service
// grades it opened, automatic, or unknown. A message with no event has no
// signal, which is not the same as unread, so there is deliberately no
// "read" column to be tempted by.
//
// The events table is keyed by (token, at, grade) so the poller can replay a
// page of events, or the same page twice after a failure, without doubling
// anything up.
//
// drafts.read_receipt carries the per-message choice while the message is
// still being written, so Esc, park, and a round trip through Gmail's drafts
// do not quietly disarm it.
const MIGRATION_15 = `
CREATE TABLE IF NOT EXISTS read_receipts (
  token      TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  thread_id  TEXT,
  send_id    INTEGER,
  message_id TEXT,
  sent_at    INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS read_receipts_thread ON read_receipts(account_id, thread_id);
CREATE INDEX IF NOT EXISTS read_receipts_message ON read_receipts(account_id, message_id);
CREATE INDEX IF NOT EXISTS read_receipts_sent ON read_receipts(sent_at DESC);

CREATE TABLE IF NOT EXISTS read_receipt_events (
  token      TEXT NOT NULL,
  at         INTEGER NOT NULL,
  grade      TEXT NOT NULL,
  why        TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (token, at, grade)
);
`;

/** ALTER TABLE ADD COLUMN has no IF NOT EXISTS, so the column is checked first; the step can then rerun like the others. */
function migrateDraftReceipts(db: Db): void {
  const have = new Set((db.prepare("PRAGMA table_info(drafts)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!have.has("read_receipt")) db.exec("ALTER TABLE drafts ADD COLUMN read_receipt INTEGER NOT NULL DEFAULT 0");
}

/** Opens (or creates) the store, applies pragmas, and migrates to the current schema. */
export function openStore(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  // Without this, a row removed by ON DELETE CASCADE fires no trigger on the
  // child table, and the attachment_files orphan trigger would miss every
  // message deleted along with its thread. See MIGRATION_13.
  db.exec("PRAGMA recursive_triggers = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export function schemaVersion(db: Db): number {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied_at INTEGER NOT NULL)");
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
  return row.v ?? 0;
}

function loadSchemaSql(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.join(here, "schema.sql"), "utf8");
}

/** Applies migrations in order. Version 1 is schema.sql; later versions append here. Each step runs in one transaction, SQL first, then any data fix-up. */
export function migrate(db: Db): void {
  const current = schemaVersion(db);
  const steps: Array<{ version: number; sql: () => string; after?: (db: Db) => void }> = [
    { version: 1, sql: loadSchemaSql },
    { version: 2, sql: () => MIGRATION_2 },
    { version: 3, sql: () => MIGRATION_3, after: (d) => reindexAllMessages(d) },
    // Snippets written before decodeEntities existed still carry &#39; and &amp;. Repair in place.
    { version: 4, sql: () => "SELECT 1", after: (d) => repairSnippets(d) },
    { version: 5, sql: () => MIGRATION_5 },
    { version: 6, sql: () => MIGRATION_6 },
    { version: 7, sql: () => "SELECT 1", after: (d) => migrateDraftsMirror(d) },
    { version: 8, sql: () => MIGRATION_8 },
    // Drafts used to count as mail in thread summaries. Recompute every thread that holds one.
    { version: 9, sql: () => "SELECT 1", after: (d) => recomputeThreadsWithDrafts(d) },
    // A thread holding nothing but a draft used to survive as a phantom row (listed under All Mail, opened empty). Recompute removes it.
    { version: 10, sql: () => "SELECT 1", after: (d) => recomputeThreadsWithDrafts(d) },
    { version: 11, sql: () => MIGRATION_11 },
    { version: 12, sql: () => "SELECT 1", after: (d) => migrateAttention(d) },
    // The unified list had no index and scanned the whole table on every keystroke of the sidebar.
    { version: 14, sql: () => "CREATE INDEX IF NOT EXISTS threads_all_sort ON threads(sort_at DESC, account_id, id);" },
    { version: 13, sql: () => MIGRATION_13 },
    { version: 15, sql: () => MIGRATION_15, after: (d) => migrateDraftReceipts(d) },
  ];
  for (const step of steps) {
    if (step.version <= current) continue;
    transaction(db, () => {
      db.exec(step.sql());
      step.after?.(db);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(step.version, Date.now());
    });
  }
  if (schemaVersion(db) !== SCHEMA_VERSION) throw new Error(`store: schema at ${schemaVersion(db)}, expected ${SCHEMA_VERSION}`);
}

const depth = new WeakMap<Db, number>();

/** Runs fn inside a transaction. Nested calls become savepoints. */
export function transaction<T>(db: Db, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  depth.set(db, level + 1);
  const name = `sp${level}`;
  if (level === 0) db.exec("BEGIN IMMEDIATE");
  else db.exec(`SAVEPOINT ${name}`);
  try {
    const out = fn();
    if (level === 0) db.exec("COMMIT");
    else db.exec(`RELEASE ${name}`);
    return out;
  } catch (err) {
    if (level === 0) db.exec("ROLLBACK");
    else db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
    throw err;
  } finally {
    depth.set(db, level);
  }
}

export function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

/** One-time repair: decode HTML entities in every stored snippet (messages and threads). */
export function repairSnippets(db: Db): void {
  for (const table of ["messages", "threads"] as const) {
    const rows = db.prepare(`SELECT rowid AS rid, snippet FROM ${table} WHERE snippet LIKE '%&%'`).all() as Array<{ rid: number; snippet: string }>;
    const upd = db.prepare(`UPDATE ${table} SET snippet = ? WHERE rowid = ?`);
    for (const r of rows) {
      const fixed = decodeEntities(r.snippet);
      if (fixed !== r.snippet) upd.run(fixed, r.rid);
    }
  }
}

/** Repair: recomputes every thread that holds a DRAFT-labelled message, so none counts a draft as mail and a drafts-only thread goes. */
export function recomputeThreadsWithDrafts(db: Db): number {
  const rows = db.prepare(`SELECT DISTINCT account_id, thread_id FROM messages WHERE label_ids_json LIKE '%"DRAFT"%'`).all() as Array<{ account_id: string; thread_id: string }>;
  for (const r of rows) recomputeThread(db, r.account_id, r.thread_id, { keepSortAt: true });
  return rows.length;
}

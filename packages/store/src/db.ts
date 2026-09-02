import { decodeEntities } from "./mail-headers.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { reindexAllMessages } from "./queries/messages.js";

export type Db = DatabaseSync;

const SCHEMA_VERSION = 6;

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

/** Opens (or creates) the store, applies pragmas, and migrates to the current schema. */
export function openStore(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
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

-- Arcforma Mail local store. SQLite is the source of truth for the UI; Gmail is
-- synced in through history.list. Timestamps are epoch milliseconds. Booleans
-- are 0/1. Gmail ids are scoped by account, so every Gmail-keyed table carries
-- account_id in its primary key.

CREATE TABLE IF NOT EXISTS accounts (
  id               TEXT PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE,
  display_name     TEXT,
  consent          TEXT NOT NULL DEFAULT 'internal',
  auth_state       TEXT NOT NULL DEFAULT 'signed_out',
  sync_state       TEXT NOT NULL DEFAULT 'new',
  history_id       TEXT,
  backfill_cursor  TEXT,
  backfill_total   INTEGER,
  backfill_done    INTEGER NOT NULL DEFAULT 0,
  last_sync_at     INTEGER,
  signature_html   TEXT,
  send_as_json     TEXT,
  error            TEXT,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  account_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id                TEXT NOT NULL,
  subject           TEXT NOT NULL DEFAULT '',
  snippet           TEXT NOT NULL DEFAULT '',
  participants_json TEXT NOT NULL DEFAULT '[]',
  first_message_at  INTEGER NOT NULL DEFAULT 0,
  last_message_at   INTEGER NOT NULL DEFAULT 0,
  sort_at           INTEGER NOT NULL DEFAULT 0,
  message_count     INTEGER NOT NULL DEFAULT 0,
  unread            INTEGER NOT NULL DEFAULT 0,
  starred           INTEGER NOT NULL DEFAULT 0,
  in_inbox          INTEGER NOT NULL DEFAULT 0,
  has_attachments   INTEGER NOT NULL DEFAULT 0,
  last_inbound_at   INTEGER,
  last_outbound_at  INTEGER,
  history_id        TEXT,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS threads_sort ON threads(account_id, sort_at DESC);
CREATE INDEX IF NOT EXISTS threads_inbox ON threads(in_inbox, sort_at DESC);
-- Every account at once, newest first: the default view, and the one with no account to narrow by.
-- Without this it is a full scan and a sort of the whole table. Measured at 60k threads: 67 ms to
-- 0.29 ms.
CREATE INDEX IF NOT EXISTS threads_all_sort ON threads(sort_at DESC, account_id, id);

CREATE TABLE IF NOT EXISTS messages (
  account_id        TEXT NOT NULL,
  id                TEXT NOT NULL,
  thread_id         TEXT NOT NULL,
  internal_date     INTEGER NOT NULL DEFAULT 0,
  from_email        TEXT NOT NULL DEFAULT '',
  from_name         TEXT NOT NULL DEFAULT '',
  to_json           TEXT NOT NULL DEFAULT '[]',
  cc_json           TEXT NOT NULL DEFAULT '[]',
  bcc_json          TEXT NOT NULL DEFAULT '[]',
  subject           TEXT NOT NULL DEFAULT '',
  snippet           TEXT NOT NULL DEFAULT '',
  message_id_header TEXT,
  in_reply_to       TEXT,
  references_header TEXT,
  label_ids_json    TEXT NOT NULL DEFAULT '[]',
  headers_json      TEXT NOT NULL DEFAULT '{}',
  has_attachments   INTEGER NOT NULL DEFAULT 0,
  size_estimate     INTEGER,
  is_auto           INTEGER NOT NULL DEFAULT 0,
  sender_type       TEXT NOT NULL DEFAULT 'person',
  direction         TEXT NOT NULL DEFAULT 'in',
  history_id        TEXT,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (account_id, id),
  FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(account_id, thread_id, internal_date);

CREATE TABLE IF NOT EXISTS message_bodies (
  account_id       TEXT NOT NULL,
  message_id       TEXT NOT NULL,
  html             TEXT,
  text             TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  fetched_at       INTEGER NOT NULL,
  PRIMARY KEY (account_id, message_id),
  FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS labels (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'user',
  color_json TEXT,
  PRIMARY KEY (account_id, id)
);

CREATE TABLE IF NOT EXISTS thread_labels (
  account_id TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  label_id   TEXT NOT NULL,
  PRIMARY KEY (account_id, thread_id, label_id),
  FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS thread_labels_label ON thread_labels(account_id, label_id);

-- Masks incoming history for a thread until the outbox row that caused the
-- local change is acknowledged, so the UI never flickers back.
CREATE TABLE IF NOT EXISTS thread_labels_pending (
  account_id  TEXT NOT NULL,
  thread_id   TEXT NOT NULL,
  outbox_id   INTEGER NOT NULL,
  add_json    TEXT NOT NULL DEFAULT '[]',
  remove_json TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, thread_id, outbox_id)
);

CREATE TABLE IF NOT EXISTS categories (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'custom',
  prompt        TEXT NOT NULL DEFAULT '',
  examples_json TEXT NOT NULL DEFAULT '[]',
  gmail_label   TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
INSERT OR IGNORE INTO categories (id, name, kind, prompt, gmail_label, position, created_at) VALUES
  ('newsletters',   'Newsletters',   'builtin', 'Editorial or recurring publication content you subscribed to.', 'Arcforma/Newsletters',   1, 0),
  ('promotions',    'Promotions',    'builtin', 'Marketing, offers, product upsell, events, and sales.',         'Arcforma/Promotions',    2, 0),
  ('jobs',          'Jobs',          'builtin', 'Applicants, applications, candidate alerts, and recruiter mail.', 'Arcforma/Jobs',        3, 0),
  ('calendar',      'Calendar',      'builtin', 'Invitations and calendar updates.',                            'Arcforma/Calendar',      4, 0),
  ('notifications', 'Notifications', 'builtin', 'Transactional or platform alerts reporting something that happened.', 'Arcforma/Notifications', 5, 0),
  ('receipts',      'Receipts',      'builtin', 'Receipts, invoices, and order confirmations.',                 'Arcforma/Receipts',      6, 0);

CREATE TABLE IF NOT EXISTS classifications (
  account_id      TEXT NOT NULL,
  thread_id       TEXT NOT NULL,
  split           TEXT NOT NULL DEFAULT 'other',
  type            TEXT,
  category_id     TEXT,
  confidence      REAL NOT NULL DEFAULT 0,
  source          TEXT NOT NULL DEFAULT 'rule',
  last_message_id TEXT,
  -- The attention model (schema 12): a 0 to 100 score, the band it falls in
  -- (needs_you, important, other), and the sentence that explains the verdict.
  -- split stays the column every older query reads: needs_you and important
  -- both file as important.
  attention       INTEGER NOT NULL DEFAULT 0,
  band            TEXT NOT NULL DEFAULT 'other',
  reason          TEXT,
  classified_at   INTEGER NOT NULL,
  PRIMARY KEY (account_id, thread_id),
  FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS classifications_split ON classifications(split, type, category_id);
CREATE INDEX IF NOT EXISTS classifications_band ON classifications(band, attention DESC);

CREATE TABLE IF NOT EXISTS corrections (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  message_id    TEXT,
  from_split    TEXT,
  to_split      TEXT,
  from_type     TEXT,
  to_type       TEXT,
  from_category TEXT,
  to_category   TEXT,
  text_excerpt  TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS snoozes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  wake_at    INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  woken_at   INTEGER
);
CREATE INDEX IF NOT EXISTS snoozes_due ON snoozes(status, wake_at);

CREATE TABLE IF NOT EXISTS reminders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      TEXT NOT NULL,
  thread_id       TEXT NOT NULL,
  last_message_id TEXT NOT NULL,
  due_at          INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      INTEGER NOT NULL,
  resolved_at     INTEGER
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders(status, due_at);

-- tracking_token holds the read receipt token this message was armed with, or
-- NULL, which is the usual case: receipts are off by default and chosen per
-- message. See read_receipts (schema 15) and packages/pixel-service.
CREATE TABLE IF NOT EXISTS send_queue (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id        TEXT NOT NULL,
  thread_id         TEXT,
  raw_mime          TEXT NOT NULL,
  meta_json         TEXT NOT NULL DEFAULT '{}',
  send_at           INTEGER NOT NULL,
  undo_until        INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'queued',
  attempts          INTEGER NOT NULL DEFAULT 0,
  gmail_message_id  TEXT,
  error             TEXT,
  tracking_token    TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS send_queue_due ON send_queue(status, send_at);

CREATE TABLE IF NOT EXISTS snippets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger    TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  body_html  TEXT NOT NULL DEFAULT '',
  body_text  TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS summaries (
  account_id      TEXT NOT NULL,
  thread_id       TEXT NOT NULL,
  last_message_id TEXT NOT NULL,
  summary         TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (account_id, thread_id)
);

-- Local mutations drain to Gmail in id order per account.
CREATE TABLE IF NOT EXISTS outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      TEXT NOT NULL,
  op              TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_drain ON outbox(account_id, status, id);

CREATE TABLE IF NOT EXISTS contacts (
  email            TEXT PRIMARY KEY,
  name             TEXT,
  domain           TEXT NOT NULL DEFAULT '',
  last_seen_at     INTEGER,
  last_inbound_at  INTEGER,
  last_outbound_at INTEGER,
  thread_count     INTEGER NOT NULL DEFAULT 0,
  photo_url        TEXT,
  web_json         TEXT,
  load_images      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS calendar_events (
  account_id      TEXT NOT NULL,
  calendar_id     TEXT NOT NULL,
  id              TEXT NOT NULL,
  summary         TEXT,
  start_at        INTEGER NOT NULL,
  end_at          INTEGER NOT NULL,
  all_day         INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'confirmed',
  busy            INTEGER NOT NULL DEFAULT 1,
  response_status TEXT NOT NULL DEFAULT 'unknown',
  hangout_link    TEXT,
  organizer_email TEXT,
  attendees_json  TEXT NOT NULL DEFAULT '[]',
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (account_id, calendar_id, id)
);
CREATE INDEX IF NOT EXISTS calendar_events_range ON calendar_events(start_at, end_at);

CREATE TABLE IF NOT EXISTS calendar_sync (
  account_id            TEXT NOT NULL,
  calendar_id           TEXT NOT NULL,
  sync_token            TEXT,
  sync_token_expires_at INTEGER,
  last_sync_at          INTEGER,
  PRIMARY KEY (account_id, calendar_id)
);

-- Full text over messages. Not an external-content table: it stores its own
-- copy of the indexed text so a row can be rebuilt without touching messages.
-- rowid is messages.fts_id (schema version 3), a stable integer handed out on
-- insert, so updates are a delete plus insert by that key and a VACUUM cannot
-- unhook the index.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  account_id UNINDEXED,
  thread_id  UNINDEXED,
  message_id UNINDEXED,
  subject,
  from_text,
  to_text,
  body,
  tokenize = 'porter unicode61'
);

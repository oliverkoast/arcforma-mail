import type { Db } from "../db.js";
import { transaction } from "../db.js";
import type { CalendarEventRow, CategoryRow, ClassificationInput, ContactRow } from "../types.js";

// ---- contacts -------------------------------------------------------------------

export function touchContact(db: Db, input: { email: string; name?: string | null; seenAt: number; direction: "in" | "out" }): void {
  const email = input.email.toLowerCase();
  const domain = email.split("@")[1] ?? "";
  db.prepare(
    `INSERT INTO contacts (email, name, domain, last_seen_at, last_inbound_at, last_outbound_at, thread_count)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(email) DO UPDATE SET
       name = COALESCE(NULLIF(excluded.name, ''), contacts.name),
       last_seen_at = MAX(COALESCE(contacts.last_seen_at, 0), excluded.last_seen_at),
       last_inbound_at = MAX(COALESCE(contacts.last_inbound_at, 0), COALESCE(excluded.last_inbound_at, 0)),
       last_outbound_at = MAX(COALESCE(contacts.last_outbound_at, 0), COALESCE(excluded.last_outbound_at, 0)),
       thread_count = contacts.thread_count + 1`
  ).run(email, input.name ?? null, domain, input.seenAt, input.direction === "in" ? input.seenAt : null, input.direction === "out" ? input.seenAt : null);
}

export function getContact(db: Db, email: string): ContactRow | null {
  return (db.prepare("SELECT * FROM contacts WHERE email = ?").get(email.toLowerCase()) as unknown as ContactRow | undefined) ?? null;
}

/** Per-sender image choice. 1 = always load, -1 = never load, 0 = no choice (the app setting decides). */
export function setLoadImages(db: Db, email: string, load: boolean): void {
  const e = email.toLowerCase();
  db.prepare(
    `INSERT INTO contacts (email, domain, load_images) VALUES (?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET load_images = excluded.load_images`
  ).run(e, e.split("@")[1] ?? "", load ? 1 : -1);
}

export function setContactWeb(db: Db, email: string, web: unknown, photoUrl?: string | null): void {
  db.prepare("UPDATE contacts SET web_json = ?, photo_url = COALESCE(?, photo_url) WHERE email = ?").run(JSON.stringify(web), photoUrl ?? null, email.toLowerCase());
}

// ---- categories and classifications ---------------------------------------------

export function listCategories(db: Db): CategoryRow[] {
  return db.prepare("SELECT * FROM categories ORDER BY kind DESC, position, name").all() as unknown as CategoryRow[];
}

export function createCategory(db: Db, input: { id: string; name: string; prompt: string; examples?: string[]; gmailLabel?: string | null }): CategoryRow {
  const pos = (db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM categories").get() as { p: number }).p;
  db.prepare("INSERT INTO categories (id, name, kind, prompt, examples_json, gmail_label, position, created_at) VALUES (?, ?, 'custom', ?, ?, ?, ?, ?)").run(
    input.id,
    input.name,
    input.prompt,
    JSON.stringify(input.examples ?? []),
    input.gmailLabel ?? `Arcforma/${input.name}`,
    pos,
    Date.now()
  );
  return db.prepare("SELECT * FROM categories WHERE id = ?").get(input.id) as unknown as CategoryRow;
}

export function deleteCategory(db: Db, id: string): void {
  transaction(db, () => {
    db.prepare("DELETE FROM categories WHERE id = ? AND kind = 'custom'").run(id);
    db.prepare("UPDATE classifications SET category_id = NULL WHERE category_id = ?").run(id);
  });
}

export function upsertClassification(db: Db, c: ClassificationInput): void {
  db.prepare(
    `INSERT INTO classifications (account_id, thread_id, split, type, category_id, confidence, source, last_message_id, classified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, thread_id) DO UPDATE SET split = excluded.split, type = excluded.type, category_id = excluded.category_id,
       confidence = excluded.confidence, source = excluded.source, last_message_id = excluded.last_message_id, classified_at = excluded.classified_at`
  ).run(c.accountId, c.threadId, c.split, c.type ?? null, c.categoryId ?? null, c.confidence ?? 0, c.source ?? "rule", c.lastMessageId ?? null, Date.now());
}

export function addCorrection(
  db: Db,
  input: {
    accountId: string;
    threadId: string;
    messageId?: string | null;
    from: { split?: string | null; type?: string | null; category?: string | null };
    to: { split?: string | null; type?: string | null; category?: string | null };
    excerpt: string;
  }
): number {
  const res = db
    .prepare(
      `INSERT INTO corrections (account_id, thread_id, message_id, from_split, to_split, from_type, to_type, from_category, to_category, text_excerpt, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(input.accountId, input.threadId, input.messageId ?? null, input.from.split ?? null, input.to.split ?? null, input.from.type ?? null, input.to.type ?? null, input.from.category ?? null, input.to.category ?? null, input.excerpt, Date.now());
  return Number(res.lastInsertRowid);
}

// ---- snippets and summaries -------------------------------------------------------

export function upsertSnippet(db: Db, s: { trigger: string; name: string; bodyHtml: string; bodyText: string }): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO snippets (trigger, name, body_html, body_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(trigger) DO UPDATE SET name = excluded.name, body_html = excluded.body_html, body_text = excluded.body_text, updated_at = excluded.updated_at`
  ).run(s.trigger, s.name, s.bodyHtml, s.bodyText, now, now);
}

export function listSnippets(db: Db): Array<{ id: number; trigger: string; name: string; body_html: string; body_text: string }> {
  return db.prepare("SELECT id, trigger, name, body_html, body_text FROM snippets ORDER BY trigger").all() as Array<{ id: number; trigger: string; name: string; body_html: string; body_text: string }>;
}

export function getSummary(db: Db, accountId: string, threadId: string, lastMessageId: string): string | null {
  const row = db.prepare("SELECT summary FROM summaries WHERE account_id = ? AND thread_id = ? AND last_message_id = ?").get(accountId, threadId, lastMessageId) as { summary: string } | undefined;
  return row?.summary ?? null;
}

export function setSummary(db: Db, accountId: string, threadId: string, lastMessageId: string, summary: string): void {
  db.prepare(
    `INSERT INTO summaries (account_id, thread_id, last_message_id, summary, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(account_id, thread_id) DO UPDATE SET last_message_id = excluded.last_message_id, summary = excluded.summary, created_at = excluded.created_at`
  ).run(accountId, threadId, lastMessageId, summary, Date.now());
}

// ---- calendar ----------------------------------------------------------------------

export interface CalendarEventInput {
  id: string;
  summary: string | null;
  startAt: number;
  endAt: number;
  allDay: boolean;
  status: string;
  busy: boolean;
  responseStatus: string;
  hangoutLink: string | null;
  organizerEmail: string | null;
  attendees: unknown[];
}

export function upsertCalendarEvents(db: Db, accountId: string, calendarId: string, events: CalendarEventInput[]): void {
  const stmt = db.prepare(
    `INSERT INTO calendar_events (account_id, calendar_id, id, summary, start_at, end_at, all_day, status, busy, response_status, hangout_link, organizer_email, attendees_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, calendar_id, id) DO UPDATE SET summary = excluded.summary, start_at = excluded.start_at, end_at = excluded.end_at,
       all_day = excluded.all_day, status = excluded.status, busy = excluded.busy, response_status = excluded.response_status,
       hangout_link = excluded.hangout_link, organizer_email = excluded.organizer_email, attendees_json = excluded.attendees_json, updated_at = excluded.updated_at`
  );
  transaction(db, () => {
    for (const e of events) {
      stmt.run(accountId, calendarId, e.id, e.summary, e.startAt, e.endAt, e.allDay ? 1 : 0, e.status, e.busy ? 1 : 0, e.responseStatus, e.hangoutLink, e.organizerEmail, JSON.stringify(e.attendees), Date.now());
    }
  });
}

export function removeCalendarEvents(db: Db, accountId: string, calendarId: string, ids: string[]): void {
  const stmt = db.prepare("DELETE FROM calendar_events WHERE account_id = ? AND calendar_id = ? AND id = ?");
  transaction(db, () => {
    for (const id of ids) stmt.run(accountId, calendarId, id);
  });
}

/**
 * After a full sync there is no deletion feed, so drop anything the snapshot
 * no longer contains. With a window, only rows that overlap it are candidates:
 * a full sync of the next two weeks says nothing about last month's meetings,
 * which the contact rail still shows.
 */
export function removeStaleCalendarEvents(db: Db, accountId: string, calendarId: string, keepIds: string[], window?: { from: number; to: number } | null): number {
  const keep = new Set(keepIds);
  const rows = window
    ? (db.prepare("SELECT id FROM calendar_events WHERE account_id = ? AND calendar_id = ? AND end_at > ? AND start_at < ?").all(accountId, calendarId, window.from, window.to) as Array<{ id: string }>)
    : (db.prepare("SELECT id FROM calendar_events WHERE account_id = ? AND calendar_id = ?").all(accountId, calendarId) as Array<{ id: string }>);
  const stale = rows.filter((r) => !keep.has(r.id)).map((r) => r.id);
  removeCalendarEvents(db, accountId, calendarId, stale);
  return stale.length;
}

/** Sign-out: the account's events and sync token go, so the rail stops showing a calendar the app can no longer read. */
export function clearCalendarForAccount(db: Db, accountId: string): { events: number } {
  return transaction(db, () => {
    const events = Number(db.prepare("DELETE FROM calendar_events WHERE account_id = ?").run(accountId).changes);
    db.prepare("DELETE FROM calendar_sync WHERE account_id = ?").run(accountId);
    return { events };
  });
}

export function listCalendarEvents(db: Db, range: { from: number; to: number }, accountIds?: string[]): CalendarEventRow[] {
  const scope = accountIds && accountIds.length ? `AND account_id IN (${accountIds.map(() => "?").join(", ")})` : "";
  return db
    .prepare(`SELECT * FROM calendar_events WHERE end_at >= ? AND start_at <= ? ${scope} ORDER BY start_at`)
    .all(range.from, range.to, ...(accountIds ?? [])) as unknown as CalendarEventRow[];
}

export function getCalendarSync(db: Db, accountId: string, calendarId: string): { sync_token: string | null; sync_token_expires_at: number | null; last_sync_at: number | null } | null {
  return (db.prepare("SELECT sync_token, sync_token_expires_at, last_sync_at FROM calendar_sync WHERE account_id = ? AND calendar_id = ?").get(accountId, calendarId) as { sync_token: string | null; sync_token_expires_at: number | null; last_sync_at: number | null } | undefined) ?? null;
}

export function setCalendarSync(db: Db, accountId: string, calendarId: string, token: string | null, expiresAt: number | null): void {
  db.prepare(
    `INSERT INTO calendar_sync (account_id, calendar_id, sync_token, sync_token_expires_at, last_sync_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(account_id, calendar_id) DO UPDATE SET sync_token = excluded.sync_token, sync_token_expires_at = excluded.sync_token_expires_at, last_sync_at = excluded.last_sync_at`
  ).run(accountId, calendarId, token, expiresAt, Date.now());
}

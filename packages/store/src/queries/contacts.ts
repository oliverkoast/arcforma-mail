// Contact rail reads: how much real correspondence exists with an address,
// when each side last wrote, and the threads it appears in. Every query keys
// on lowercased email; to/cc lists are walked with json_each so a display name
// in the header never hides a match.

import type { Db } from "../db.js";
import type { ThreadRow } from "../types.js";

export interface ContactStats {
  email: string;
  /** Threads where they wrote to us and we wrote back to them. */
  twoWayThreads: number;
  /** Threads the address appears in at all. */
  threads: number;
  /** Newest message from them. */
  lastFromAt: number | null;
  /** Newest outbound message that has them on To or Cc. */
  lastToAt: number | null;
}

/** The address is on To or Cc of message m. Takes the lowercased email twice. */
export const TO_OR_CC = `(EXISTS (SELECT 1 FROM json_each(m.to_json) j WHERE lower(COALESCE(j.value ->> 'email', '')) = ?)
  OR EXISTS (SELECT 1 FROM json_each(m.cc_json) j WHERE lower(COALESCE(j.value ->> 'email', '')) = ?))`;

export function contactStats(db: Db, email: string): ContactStats {
  const e = email.toLowerCase();
  const twoWay = db
    .prepare(
      `SELECT COUNT(*) AS n FROM threads t
       WHERE EXISTS (SELECT 1 FROM messages m WHERE m.account_id = t.account_id AND m.thread_id = t.id AND m.direction = 'in' AND lower(m.from_email) = ?)
         AND EXISTS (SELECT 1 FROM messages m WHERE m.account_id = t.account_id AND m.thread_id = t.id AND m.direction = 'out' AND ${TO_OR_CC})`
    )
    .get(e, e, e) as { n: number };
  const any = db
    .prepare(
      `SELECT COUNT(*) AS n FROM threads t
       WHERE EXISTS (SELECT 1 FROM messages m WHERE m.account_id = t.account_id AND m.thread_id = t.id AND (lower(m.from_email) = ? OR ${TO_OR_CC}))`
    )
    .get(e, e, e) as { n: number };
  const from = db.prepare("SELECT MAX(internal_date) AS t FROM messages m WHERE lower(m.from_email) = ?").get(e) as { t: number | null };
  const to = db.prepare(`SELECT MAX(internal_date) AS t FROM messages m WHERE m.direction = 'out' AND ${TO_OR_CC}`).get(e, e) as { t: number | null };
  return { email: e, twoWayThreads: twoWay.n, threads: any.n, lastFromAt: from.t ?? null, lastToAt: to.t ?? null };
}

/** Newest threads the address took part in, across accounts, trash and spam excluded. */
export function threadsWithContact(db: Db, email: string, limit = 8): ThreadRow[] {
  const e = email.toLowerCase();
  return db
    .prepare(
      `SELECT t.* FROM threads t
       WHERE EXISTS (SELECT 1 FROM messages m WHERE m.account_id = t.account_id AND m.thread_id = t.id AND (lower(m.from_email) = ? OR ${TO_OR_CC}))
         AND NOT EXISTS (SELECT 1 FROM thread_labels l WHERE l.account_id = t.account_id AND l.thread_id = t.id AND l.label_id IN ('TRASH', 'SPAM'))
       ORDER BY t.last_message_at DESC LIMIT ?`
    )
    .all(e, e, e, limit) as unknown as ThreadRow[];
}

/** Display name for the address from the newest message that carried one, else the contacts row, else null. */
export function contactName(db: Db, email: string): string | null {
  const e = email.toLowerCase();
  const row = db.prepare("SELECT from_name FROM messages WHERE lower(from_email) = ? AND from_name != '' ORDER BY internal_date DESC LIMIT 1").get(e) as { from_name: string } | undefined;
  if (row?.from_name) return row.from_name;
  const c = db.prepare("SELECT name FROM contacts WHERE email = ?").get(e) as { name: string | null } | undefined;
  return c?.name ?? null;
}

/** Records the resolved photo: a URL, or an empty string meaning "looked, found nothing" so the chain is not rerun every open. */
export function setContactPhoto(db: Db, email: string, photoUrl: string | null): void {
  const e = email.toLowerCase();
  db.prepare(
    `INSERT INTO contacts (email, domain, photo_url) VALUES (?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET photo_url = excluded.photo_url`
  ).run(e, e.split("@")[1] ?? "", photoUrl ?? "");
}

export function setContactWebJson(db: Db, email: string, web: unknown): void {
  const e = email.toLowerCase();
  db.prepare(
    `INSERT INTO contacts (email, domain, web_json) VALUES (?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET web_json = excluded.web_json`
  ).run(e, e.split("@")[1] ?? "", JSON.stringify(web));
}

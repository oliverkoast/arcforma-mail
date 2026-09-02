import type { Db } from "../db.js";
import type { DraftRow } from "../types.js";

export interface DraftInput {
  id?: number | null;
  accountId: string;
  threadId?: string | null;
  mode?: "new" | "reply" | "replyAll" | "forward";
  to: Array<{ email: string; name: string }>;
  cc?: Array<{ email: string; name: string }>;
  bcc?: Array<{ email: string; name: string }>;
  subject: string;
  bodyHtml: string;
  quotedHtml?: string;
  inReplyTo?: string | null;
  references?: string | null;
}

/** Inserts or updates a local draft. Returns the row id. */
export function saveDraft(db: Db, d: DraftInput): number {
  const now = Date.now();
  if (d.id) {
    db.prepare(
      `UPDATE drafts SET account_id = ?, thread_id = ?, mode = ?, to_json = ?, cc_json = ?, bcc_json = ?, subject = ?, body_html = ?, quoted_html = ?,
         in_reply_to = ?, references_header = ?, updated_at = ? WHERE id = ?`
    ).run(
      d.accountId,
      d.threadId ?? null,
      d.mode ?? "new",
      JSON.stringify(d.to),
      JSON.stringify(d.cc ?? []),
      JSON.stringify(d.bcc ?? []),
      d.subject,
      d.bodyHtml,
      d.quotedHtml ?? "",
      d.inReplyTo ?? null,
      d.references ?? null,
      now,
      d.id
    );
    return d.id;
  }
  const res = db
    .prepare(
      `INSERT INTO drafts (account_id, thread_id, mode, to_json, cc_json, bcc_json, subject, body_html, quoted_html, in_reply_to, references_header, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      d.accountId,
      d.threadId ?? null,
      d.mode ?? "new",
      JSON.stringify(d.to),
      JSON.stringify(d.cc ?? []),
      JSON.stringify(d.bcc ?? []),
      d.subject,
      d.bodyHtml,
      d.quotedHtml ?? "",
      d.inReplyTo ?? null,
      d.references ?? null,
      now,
      now
    );
  return Number(res.lastInsertRowid);
}

export function getDraft(db: Db, id: number): DraftRow | null {
  return (db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as unknown as DraftRow | undefined) ?? null;
}

export function listDrafts(db: Db, accountIds?: string[]): DraftRow[] {
  if (accountIds && accountIds.length) {
    const marks = accountIds.map(() => "?").join(", ");
    return db.prepare(`SELECT * FROM drafts WHERE account_id IN (${marks}) ORDER BY updated_at DESC`).all(...accountIds) as unknown as DraftRow[];
  }
  return db.prepare("SELECT * FROM drafts ORDER BY updated_at DESC").all() as unknown as DraftRow[];
}

export function deleteDraft(db: Db, id: number): void {
  db.prepare("DELETE FROM drafts WHERE id = ?").run(id);
}

export function draftCount(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM drafts").get() as { n: number }).n;
}

import type { Db } from "../db.js";
import { transaction } from "../db.js";
import type { DraftMirrorState, DraftRow } from "../types.js";

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
  /** Carried over when a queued send is undone or fails: the Gmail draft still exists and the update reuses it. */
  gmailDraftId?: string | null;
}

/**
 * Inserts or updates a local draft written in this app. Returns the row id.
 * Every save marks the mirror pending and stamps local_edited_at, so the next
 * drain pushes the row to Gmail and a Gmail-side edit from the same minute
 * loses to it.
 */
export function saveDraft(db: Db, d: DraftInput, now = Date.now()): number {
  if (d.id) {
    db.prepare(
      `UPDATE drafts SET account_id = ?, thread_id = ?, mode = ?, to_json = ?, cc_json = ?, bcc_json = ?, subject = ?, body_html = ?, quoted_html = ?,
         in_reply_to = ?, references_header = ?, updated_at = ?, local_edited_at = ?, mirror_state = 'pending', mirror_error = NULL WHERE id = ?`
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
      now,
      d.id
    );
    return d.id;
  }
  const res = db
    .prepare(
      `INSERT INTO drafts (account_id, thread_id, mode, to_json, cc_json, bcc_json, subject, body_html, quoted_html, in_reply_to, references_header, created_at, updated_at,
         gmail_draft_id, mirror_state, origin, local_edited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'local', ?)`
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
      now,
      d.gmailDraftId ?? null,
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

/** Removes the local row only. Callers that want the Gmail copy gone too queue a draftDelete. */
export function deleteDraft(db: Db, id: number): void {
  db.prepare("DELETE FROM drafts WHERE id = ?").run(id);
}

export function draftCount(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM drafts").get() as { n: number }).n;
}

// ---- Gmail mirror ---------------------------------------------------------

export function findDraftByGmailId(db: Db, accountId: string, gmailDraftId: string): DraftRow | null {
  return (db.prepare("SELECT * FROM drafts WHERE account_id = ? AND gmail_draft_id = ?").get(accountId, gmailDraftId) as unknown as DraftRow | undefined) ?? null;
}

export function findDraftByGmailMessageId(db: Db, accountId: string, gmailMessageId: string): DraftRow | null {
  return (db.prepare("SELECT * FROM drafts WHERE account_id = ? AND gmail_message_id = ?").get(accountId, gmailMessageId) as unknown as DraftRow | undefined) ?? null;
}

/** Message ids behind the account's mirrored drafts. A DRAFT-labelled message outside this set was not written here. */
export function knownGmailMessageIds(db: Db, accountId: string): Set<string> {
  const rows = db.prepare("SELECT gmail_message_id FROM drafts WHERE account_id = ? AND gmail_message_id IS NOT NULL").all(accountId) as Array<{ gmail_message_id: string }>;
  return new Set(rows.map((r) => r.gmail_message_id));
}

/** Drafts whose last local edit has not reached Gmail, for the mirror to pick up again after a restart. */
export function listPendingMirrorDrafts(db: Db): DraftRow[] {
  return db.prepare("SELECT * FROM drafts WHERE mirror_state = 'pending' ORDER BY id").all() as unknown as DraftRow[];
}

/** Every local draft that has a Gmail counterpart, for reconciling against drafts.list. */
export function listMirroredDrafts(db: Db, accountId: string): DraftRow[] {
  return db.prepare("SELECT * FROM drafts WHERE account_id = ? AND gmail_draft_id IS NOT NULL ORDER BY id").all(accountId) as unknown as DraftRow[];
}

export interface MirrorPatch {
  gmailDraftId?: string | null;
  gmailMessageId?: string | null;
  state: DraftMirrorState;
  error?: string | null;
  at?: number;
}

/** Records the outcome of a mirror attempt. Returns false when the row is gone. */
export function setDraftMirror(db: Db, id: number, patch: MirrorPatch): boolean {
  const sets = ["mirror_state = ?", "mirror_error = ?"];
  const args: Array<string | number | null> = [patch.state, patch.error ?? null];
  if (patch.gmailDraftId !== undefined) {
    sets.push("gmail_draft_id = ?");
    args.push(patch.gmailDraftId);
  }
  if (patch.gmailMessageId !== undefined) {
    sets.push("gmail_message_id = ?");
    args.push(patch.gmailMessageId);
  }
  if (patch.state === "synced") {
    sets.push("mirrored_at = ?");
    args.push(patch.at ?? Date.now());
  }
  args.push(id);
  const res = db.prepare(`UPDATE drafts SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return Number(res.changes) === 1;
}

export interface GmailDraftImport {
  accountId: string;
  gmailDraftId: string;
  gmailMessageId: string;
  threadId: string | null;
  mode: "new" | "reply" | "replyAll" | "forward";
  to: Array<{ email: string; name: string }>;
  cc: Array<{ email: string; name: string }>;
  bcc: Array<{ email: string; name: string }>;
  subject: string;
  bodyHtml: string;
  quotedHtml: string;
  inReplyTo: string | null;
  references: string | null;
}

/**
 * Writes a draft read from Gmail. A row already tied to the Gmail draft is
 * replaced in place (an edit made in Gmail); otherwise a new row is inserted
 * with origin gmail. Either way the row is synced and local_edited_at is left
 * alone: nothing was typed here. Returns the local id.
 */
export function upsertGmailDraft(db: Db, d: GmailDraftImport, now = Date.now()): number {
  return transaction(db, () => {
    const existing = findDraftByGmailId(db, d.accountId, d.gmailDraftId);
    if (existing) {
      db.prepare(
        `UPDATE drafts SET thread_id = ?, mode = ?, to_json = ?, cc_json = ?, bcc_json = ?, subject = ?, body_html = ?, quoted_html = ?, in_reply_to = ?, references_header = ?,
           updated_at = ?, gmail_message_id = ?, mirror_state = 'synced', mirror_error = NULL, mirrored_at = ? WHERE id = ?`
      ).run(
        d.threadId,
        d.mode,
        JSON.stringify(d.to),
        JSON.stringify(d.cc),
        JSON.stringify(d.bcc),
        d.subject,
        d.bodyHtml,
        d.quotedHtml,
        d.inReplyTo,
        d.references,
        now,
        d.gmailMessageId,
        now,
        existing.id
      );
      return existing.id;
    }
    const res = db
      .prepare(
        `INSERT INTO drafts (account_id, thread_id, mode, to_json, cc_json, bcc_json, subject, body_html, quoted_html, in_reply_to, references_header, created_at, updated_at,
           gmail_draft_id, gmail_message_id, mirror_state, mirrored_at, origin, local_edited_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, 'gmail', NULL)`
      )
      .run(
        d.accountId,
        d.threadId,
        d.mode,
        JSON.stringify(d.to),
        JSON.stringify(d.cc),
        JSON.stringify(d.bcc),
        d.subject,
        d.bodyHtml,
        d.quotedHtml,
        d.inReplyTo,
        d.references,
        now,
        now,
        d.gmailDraftId,
        d.gmailMessageId,
        now
      );
    return Number(res.lastInsertRowid);
  });
}

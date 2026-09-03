// The index of attachment bytes cached on disk (schema 13). The store records
// where a file went; it never writes, reads, or deletes the file itself. The
// app owns the folder, and every path it hands back is checked against the
// attachments root again before anything opens it.

import type { Db } from "../db.js";
import type { AttachmentFileRow } from "../types.js";

export interface AttachmentFileInput {
  accountId: string;
  messageId: string;
  /** Which part of the message: the Gmail part id, or the index when a part has none. Stable per message. */
  attachmentKey: string;
  /** The sanitised name on disk. Never the raw name off the network. */
  filename: string;
  mimeType: string;
  bytes: number;
  path: string;
}

export function recordAttachmentFile(db: Db, input: AttachmentFileInput, now = Date.now()): void {
  db.prepare(
    `INSERT INTO attachment_files (account_id, message_id, attachment_key, filename, mime_type, bytes, path, cached_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, message_id, attachment_key) DO UPDATE SET
       filename = excluded.filename, mime_type = excluded.mime_type, bytes = excluded.bytes,
       path = excluded.path, cached_at = excluded.cached_at`
  ).run(input.accountId, input.messageId, input.attachmentKey, input.filename, input.mimeType, input.bytes, input.path, now);
}

export function getAttachmentFile(db: Db, accountId: string, messageId: string, attachmentKey: string): AttachmentFileRow | null {
  return (
    (db
      .prepare("SELECT * FROM attachment_files WHERE account_id = ? AND message_id = ? AND attachment_key = ?")
      .get(accountId, messageId, attachmentKey) as unknown as AttachmentFileRow | undefined) ?? null
  );
}

export function listAttachmentFiles(db: Db, accountId: string, messageId: string): AttachmentFileRow[] {
  return db
    .prepare("SELECT * FROM attachment_files WHERE account_id = ? AND message_id = ? ORDER BY attachment_key")
    .all(accountId, messageId) as unknown as AttachmentFileRow[];
}

/**
 * Drops one cache row. Used when the file it points at is gone from disk (the
 * folder was emptied by hand), so the next open fetches instead of failing.
 * The delete trigger sends the path to orphan_attachments, which is harmless:
 * unlinking a file that is already gone is a no-op.
 */
export function forgetAttachmentFile(db: Db, accountId: string, messageId: string, attachmentKey: string): void {
  db.prepare("DELETE FROM attachment_files WHERE account_id = ? AND message_id = ? AND attachment_key = ?").run(accountId, messageId, attachmentKey);
}

/**
 * Takes up to `limit` paths whose message is gone and removes them from the
 * table. The caller unlinks the files. Taking and returning in one step means a
 * crash mid-sweep loses at most one batch of paths rather than replaying them
 * forever.
 */
export function drainOrphanAttachments(db: Db, limit = 200): string[] {
  const rows = db.prepare("SELECT id, path FROM orphan_attachments ORDER BY id LIMIT ?").all(limit) as Array<{ id: number; path: string }>;
  if (rows.length === 0) return [];
  const del = db.prepare("DELETE FROM orphan_attachments WHERE id = ?");
  for (const r of rows) del.run(r.id);
  return rows.map((r) => r.path);
}

export function countOrphanAttachments(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM orphan_attachments").get() as { n: number }).n;
}

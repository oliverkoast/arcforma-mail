import type { Db } from "../db.js";
import { transaction } from "../db.js";
import type { LabelRow } from "../types.js";

export interface LabelInput {
  id: string;
  name: string;
  type?: string;
  color?: unknown;
}

export function upsertLabels(db: Db, accountId: string, labels: LabelInput[]): void {
  const stmt = db.prepare(
    `INSERT INTO labels (account_id, id, name, type, color_json) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(account_id, id) DO UPDATE SET name = excluded.name, type = excluded.type, color_json = excluded.color_json`
  );
  transaction(db, () => {
    for (const l of labels) stmt.run(accountId, l.id, l.name, l.type ?? "user", l.color ? JSON.stringify(l.color) : null);
  });
}

export function listLabels(db: Db, accountId: string): LabelRow[] {
  return db.prepare("SELECT * FROM labels WHERE account_id = ? ORDER BY type, name").all(accountId) as unknown as LabelRow[];
}

export function labelIdByName(db: Db, accountId: string, name: string): string | null {
  const row = db.prepare("SELECT id FROM labels WHERE account_id = ? AND name = ?").get(accountId, name) as { id: string } | undefined;
  return row?.id ?? null;
}

export function threadLabelIds(db: Db, accountId: string, threadId: string): string[] {
  return (db.prepare("SELECT label_id FROM thread_labels WHERE account_id = ? AND thread_id = ? ORDER BY label_id").all(accountId, threadId) as Array<{ label_id: string }>).map((r) => r.label_id);
}

export function setThreadLabels(db: Db, accountId: string, threadId: string, labelIds: Iterable<string>): void {
  transaction(db, () => {
    db.prepare("DELETE FROM thread_labels WHERE account_id = ? AND thread_id = ?").run(accountId, threadId);
    const ins = db.prepare("INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES (?, ?, ?)");
    for (const id of labelIds) ins.run(accountId, threadId, id);
  });
}

export function addPendingMask(db: Db, accountId: string, threadId: string, outboxId: number, add: string[], remove: string[]): void {
  db.prepare(
    "INSERT OR REPLACE INTO thread_labels_pending (account_id, thread_id, outbox_id, add_json, remove_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(accountId, threadId, outboxId, JSON.stringify(add), JSON.stringify(remove), Date.now());
}

export interface PendingMask {
  outbox_id: number;
  add: string[];
  remove: string[];
}

/** Every unacknowledged local label change for the thread, oldest first. Entries are label ids or label names. */
export function listPendingMasks(db: Db, accountId: string, threadId: string): PendingMask[] {
  const rows = db.prepare("SELECT outbox_id, add_json, remove_json FROM thread_labels_pending WHERE account_id = ? AND thread_id = ? ORDER BY outbox_id").all(accountId, threadId) as Array<{ outbox_id: number; add_json: string; remove_json: string }>;
  return rows.map((r) => ({ outbox_id: r.outbox_id, add: JSON.parse(r.add_json) as string[], remove: JSON.parse(r.remove_json) as string[] }));
}

export function hasPendingMask(db: Db, accountId: string, threadId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM thread_labels_pending WHERE account_id = ? AND thread_id = ? LIMIT 1").get(accountId, threadId));
}

export function clearPendingMask(db: Db, outboxId: number): void {
  db.prepare("DELETE FROM thread_labels_pending WHERE outbox_id = ?").run(outboxId);
}

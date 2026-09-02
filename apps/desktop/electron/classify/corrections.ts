// Manual re-files feed the corrections bank, apply the matching Gmail label
// through the outbox, and, when a custom category is added, reclassify the
// last 30 days in the background so the new folder fills without a restart.

import {
  addCorrection,
  changeThreadLabels,
  getBody,
  getClassification,
  listCategories,
  listThreadMessages,
  stripHtml,
  upsertClassification,
  type CategoryRow,
  type Db,
} from "@arcforma/store";
import { buildExcerpt } from "./fewshot.js";
import { pickDecidingMessage } from "./rules.js";
import type { RefileTarget } from "../../shared/types.js";

const BUILTIN_TYPES = new Set(["newsletters", "promotions", "jobs", "calendar", "notifications", "receipts"]);

export function labelForCategory(categories: CategoryRow[], id: string | null): string | null {
  if (!id) return null;
  return categories.find((c) => c.id === id)?.gmail_label ?? null;
}

/** The classification excerpt for a thread, from its deciding message. */
export function threadExcerpt(db: Db, accountId: string, threadId: string): { excerpt: string; messageId: string | null } {
  const messages = listThreadMessages(db, accountId, threadId);
  const m = pickDecidingMessage(messages);
  if (!m) return { excerpt: "", messageId: null };
  const body = getBody(db, accountId, m.id);
  const text = body?.text ?? (body?.html ? stripHtml(body.html) : m.snippet);
  const to = (JSON.parse(m.to_json) as Array<{ email: string }>).map((a) => a.email);
  return { excerpt: buildExcerpt({ fromEmail: m.from_email, fromName: m.from_name, subject: m.subject, to, body: text }), messageId: m.id };
}

/** Splits a refile target into the store's (type, category_id) pair. */
export function targetColumns(to: RefileTarget): { type: string | null; categoryId: string | null } {
  if (!to.category) return { type: null, categoryId: null };
  return BUILTIN_TYPES.has(to.category) ? { type: to.category, categoryId: null } : { type: null, categoryId: to.category };
}

/**
 * Records the correction, writes the manual classification, and mirrors the
 * category label to Gmail (old label off, new label on). Returns the outbox id
 * when a label change was queued.
 */
export function refileThread(db: Db, accountId: string, threadId: string, to: RefileTarget): number | null {
  const categories = listCategories(db);
  const current = getClassification(db, accountId, threadId);
  const next = targetColumns(to);
  const { excerpt, messageId } = threadExcerpt(db, accountId, threadId);
  addCorrection(db, {
    accountId,
    threadId,
    messageId,
    from: { split: current?.split ?? null, type: current?.type ?? null, category: current?.category_id ?? null },
    to: { split: to.split, type: next.type, category: next.categoryId },
    excerpt,
  });
  upsertClassification(db, { accountId, threadId, split: to.split, type: next.type, categoryId: next.categoryId, confidence: 1, source: "manual", lastMessageId: messageId });
  const oldLabel = labelForCategory(categories, current?.category_id ?? current?.type ?? null);
  const newLabel = labelForCategory(categories, next.categoryId ?? next.type);
  if (oldLabel === newLabel) return null;
  const change: { addNames?: string[]; removeNames?: string[] } = {};
  if (newLabel) change.addNames = [newLabel];
  if (oldLabel) change.removeNames = [oldLabel];
  return changeThreadLabels(db, accountId, threadId, change);
}

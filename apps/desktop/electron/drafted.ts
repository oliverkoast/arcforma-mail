import type { DraftRow } from "@arcforma/store";
import type { Address, ThreadSummary } from "../shared/types.js";
import { snippetOf } from "./scheduled.js";

/**
 * Drafts as rows in the inbox.
 *
 * A draft is a message being written, and the inbox is where the writing happens, so Important
 * and Everything list each one at the time it was started. It is marked DRAFT, opens straight into
 * the compose, and the triage keys refuse it: there is nothing to archive or star about a message
 * that has not gone anywhere yet.
 *
 * The row is a pseudo-thread with a prefixed id, the same device the Scheduled view uses for a
 * queued send. It is placed by created_at, not updated_at: autosave touches updated_at every few
 * seconds while typing, and a row that climbed the list with every keystroke would be noise.
 *
 * A reply draft belongs to a thread that may already be on the page. That thread gets the marker
 * instead of a second row, so one conversation is never listed twice.
 */
export const DRAFT_PREFIX = "draft:";

export function isDraftThreadId(threadId: string): boolean {
  return threadId.startsWith(DRAFT_PREFIX);
}

export function draftIdOf(threadId: string): number | null {
  if (!isDraftThreadId(threadId)) return null;
  const n = Number(threadId.slice(DRAFT_PREFIX.length));
  return Number.isInteger(n) ? n : null;
}

function parseList(json: string): Address[] {
  try {
    const v = JSON.parse(json) as Address[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function hasSubstance(d: Pick<DraftRow, "subject" | "to_json" | "cc_json" | "body_html">): boolean {
  if (d.subject.trim()) return true;
  if (parseList(d.to_json).length || parseList(d.cc_json).length) return true;
  return snippetOf(d.body_html).trim().length > 0;
}

export function draftSummary(row: DraftRow, sender: Address): ThreadSummary {
  const recipients = [...parseList(row.to_json), ...parseList(row.cc_json)];
  return {
    accountId: row.account_id,
    id: `${DRAFT_PREFIX}${row.id}`,
    subject: row.subject,
    snippet: snippetOf(row.body_html),
    participants: recipients.length ? recipients : [sender],
    lastMessageAt: row.created_at,
    sortAt: row.created_at,
    messageCount: 1,
    unread: false,
    starred: false,
    inInbox: true,
    hasAttachments: false,
    split: null,
    type: null,
    categoryId: null,
    attention: null,
    band: null,
    attentionReason: null,
    wakeAt: null,
    noReplyBy: null,
    queue: null,
    canUnsubscribe: false,
    unsubscribeState: null,
    draft: { draftId: row.id, createdAt: row.created_at },
  };
}

/**
 * Folds drafts into a page of inbox rows. A draft whose thread is already listed marks that row;
 * every other draft becomes a row of its own. The result is ordered by time, newest first, which
 * for a draft means when it was started.
 */
export function mergeDrafts(rows: ThreadSummary[], drafts: DraftRow[], sender: (accountId: string) => Address): ThreadSummary[] {
  const byThread = new Map(rows.map((r) => [`${r.accountId}:${r.id}`, r]));
  const extra: ThreadSummary[] = [];
  for (const d of drafts) {
    // A draft with no subject, nobody on it and nothing written is not a message being written. It
    // stays in the Drafts view; the inbox is for the ones that are under way.
    if (!hasSubstance(d)) continue;
    const host = d.thread_id ? byThread.get(`${d.account_id}:${d.thread_id}`) : undefined;
    if (host) {
      // Keep the earliest draft on a thread as its marker; more than one draft on a thread is rare.
      if (!host.draft || d.created_at < host.draft.createdAt) host.draft = { draftId: d.id, createdAt: d.created_at };
      continue;
    }
    extra.push(draftSummary(d, sender(d.account_id)));
  }
  if (extra.length === 0) return rows;
  return [...rows, ...extra].sort((a, b) => b.sortAt - a.sortAt);
}

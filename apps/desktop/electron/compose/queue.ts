// Queues an outgoing message: builds the RFC 822 text with the account's
// Gmail signature, inserts a send_queue row whose send_at is now plus the undo
// window (or the chosen send-later time), and can hand the draft back when
// the send is undone in time.

import { buildRawMessage } from "@arcforma/gmail";
import { cancelSend, enqueueSend, getAccount, getSend, undoWindowMs, type Db } from "@arcforma/store";
import type { Address, ComposeDraft, SendResult, UndoSendResult } from "../../shared/types.js";

export interface QueueOptions {
  /** Absolute time for send later; omitted means now plus the undo window. */
  sendAt?: number | null;
  now?: number;
  /** Overrides the account's stored signature (tests). */
  signatureHtml?: string | null;
}

export function senderFor(db: Db, accountId: string): Address {
  const row = getAccount(db, accountId);
  if (!row) throw new Error(`Unknown account ${accountId}.`);
  return { email: row.email, name: row.display_name ?? "" };
}

/** The sendAs signature stored at sign-in; empty until an account exists. */
export function signatureFor(db: Db, accountId: string): string {
  return getAccount(db, accountId)?.signature_html ?? "";
}

/** Body plus quoted history as one HTML document, for previews. The sent message gets the signature between the two. */
export function composeHtml(draft: Pick<ComposeDraft, "bodyHtml" | "quotedHtml">): string {
  const body = draft.bodyHtml.trim() || "<p></p>";
  if (!draft.quotedHtml.trim()) return body;
  return `${body}<br><div class="gmail_quote">${draft.quotedHtml}</div>`;
}

export function validateDraft(draft: ComposeDraft): void {
  if (draft.to.length === 0 && draft.cc.length === 0 && draft.bcc.length === 0) throw new Error("Add at least one recipient.");
  const bad = [...draft.to, ...draft.cc, ...draft.bcc].find((a) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email));
  if (bad) throw new Error(`${bad.email} is not a valid address.`);
}

export async function queueSend(db: Db, draft: ComposeDraft, opts: QueueOptions = {}): Promise<SendResult> {
  validateDraft(draft);
  const now = opts.now ?? Date.now();
  const window = undoWindowMs(db);
  const later = Boolean(opts.sendAt && opts.sendAt > now);
  const sendAt = later ? opts.sendAt! : now + window;
  const undoUntil = sendAt;
  const built = await buildRawMessage({
    from: senderFor(db, draft.accountId),
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    html: draft.bodyHtml.trim() || "<p></p>",
    // The signature goes between the body and the quote; buildRawMessage owns that order.
    quotedHtml: draft.quotedHtml,
    inReplyTo: draft.inReplyTo ?? null,
    references: draft.references ?? null,
    signatureHtml: opts.signatureHtml === undefined ? signatureFor(db, draft.accountId) : opts.signatureHtml,
    // A send-later message is dated when it goes out, not when it was written.
    date: later ? new Date(sendAt) : undefined,
  });
  const row = enqueueSend(db, {
    accountId: draft.accountId,
    threadId: draft.threadId ?? null,
    rawMime: built.mime,
    sendAt,
    undoUntil,
    meta: { draft: { ...draft, draftId: null } },
  });
  return { id: row.id, sendAt: row.send_at, undoUntil: row.undo_until };
}

/** Cancels a queued send and returns the draft it carried, so the compose can reopen. */
export function undoSend(db: Db, id: number): UndoSendResult {
  const row = getSend(db, id);
  if (!row) return { cancelled: false, draft: null };
  const cancelled = cancelSend(db, id);
  if (!cancelled) return { cancelled: false, draft: null };
  try {
    const meta = JSON.parse(row.meta_json) as { draft?: ComposeDraft };
    return { cancelled: true, draft: meta.draft ?? null };
  } catch {
    return { cancelled: true, draft: null };
  }
}

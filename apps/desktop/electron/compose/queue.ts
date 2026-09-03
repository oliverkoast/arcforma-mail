// Queues an outgoing message: builds the RFC 822 text with the account's
// Gmail signature, inserts a send_queue row whose send_at is now plus the undo
// window (or the chosen send-later time), and can hand the draft back when
// the send is undone in time.

import { buildRawMessage } from "@arcforma/gmail";
import { cancelSend, createReceipt, deleteReceiptForSend, enqueueSend, getAccount, getSend, setSendTrackingToken, undoWindowMs, type Db } from "@arcforma/store";
import { newReceiptToken } from "../receipts/pixel.js";
import type { ReceiptArmer } from "../receipts/arm.js";
import type { Address, ComposeDraft, ReceiptArmResult, SendResult, UndoSendResult } from "../../shared/types.js";

export interface QueueOptions {
  /** Absolute time for send later; omitted means now plus the undo window. */
  sendAt?: number | null;
  now?: number;
  /** Overrides the account's stored signature (tests). */
  signatureHtml?: string | null;
  /** The Gmail draft this message was mirrored as. Deleted once the send succeeds; handed back on undo or failure. */
  gmailDraftId?: string | null;
  /** The pixel service, when the message asked for a read receipt. Absent means no receipt can be armed. */
  receipts?: ReceiptArmer;
}

/** No receipt was asked for, which is the answer for almost every message. */
const NO_RECEIPT: ReceiptArmResult = { requested: false, armed: false, problem: null };

/**
 * Arms the receipt this message asked for, if it asked for one. Everything
 * that can go wrong here comes back as a `problem` sentence rather than a
 * throw: a receipt that could not be armed must never cost the sender a send.
 */
async function armReceipt(draft: ComposeDraft, sentAt: number, armer: ReceiptArmer | undefined): Promise<ReceiptArmResult & { token: string | null; pixelHtml: string | null }> {
  if (draft.readReceipt !== true) return { ...NO_RECEIPT, token: null, pixelHtml: null };
  const refuse = (problem: string) => ({ requested: true, armed: false, problem, token: null, pixelHtml: null });
  if (!armer) return refuse("no pixel service is set up yet; see packages/pixel-service/README.md");
  if (!armer.usable()) return refuse(armer.unavailable());
  const token = newReceiptToken();
  try {
    await armer.register(token, sentAt);
  } catch (err) {
    return refuse((err as Error).message || "the pixel service did not answer");
  }
  return { requested: true, armed: true, problem: null, token, pixelHtml: armer.pixelHtml(token) };
}

/** What a send_queue row remembers about the draft it came from. */
export interface SendMeta {
  draft?: ComposeDraft;
  gmailDraftId?: string | null;
}

export function sendMeta(row: { meta_json: string }): SendMeta {
  try {
    return JSON.parse(row.meta_json) as SendMeta;
  } catch {
    return {};
  }
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

/** True when the body carries text. A forward is the exception: its quoted history is the message, so it may go with nothing added. A reply that only quotes is a slip. */
export function hasSendableBody(draft: Pick<ComposeDraft, "mode" | "bodyHtml" | "quotedHtml">): boolean {
  const text = draft.bodyHtml.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
  return text.length > 0 || (draft.mode === "forward" && draft.quotedHtml.trim().length > 0);
}

export function validateDraft(draft: ComposeDraft): void {
  if (draft.to.length === 0 && draft.cc.length === 0 && draft.bcc.length === 0) throw new Error("Add at least one recipient.");
  if (!hasSendableBody(draft)) throw new Error("Write something before sending.");
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
  // Registered against the time the message actually goes out, not the time it
  // was written: the service grades a fetch by how soon after sending it came.
  const receipt = await armReceipt(draft, sendAt, opts.receipts);
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
    // Last of everything in the HTML part, and never in the plain text part.
    trackingPixelHtml: receipt.pixelHtml,
  });
  const row = enqueueSend(db, {
    accountId: draft.accountId,
    threadId: draft.threadId ?? null,
    rawMime: built.mime,
    sendAt,
    undoUntil,
    meta: { draft: { ...draft, draftId: null }, gmailDraftId: opts.gmailDraftId ?? null } satisfies SendMeta,
  });
  if (receipt.token) {
    // The token belongs to the queued row, so an undo or a terminal failure can take it back with the message.
    setSendTrackingToken(db, row.id, receipt.token);
    createReceipt(db, { token: receipt.token, accountId: draft.accountId, threadId: draft.threadId ?? null, sendId: row.id, sentAt: sendAt });
  }
  return { id: row.id, sendAt: row.send_at, undoUntil: row.undo_until, receipt: { requested: receipt.requested, armed: receipt.armed, problem: receipt.problem } };
}

/** Cancels a queued send and returns the draft it carried, plus the Gmail draft it was mirrored as, so the compose can reopen. */
export function undoSend(db: Db, id: number): UndoSendResult & { gmailDraftId: string | null } {
  const row = getSend(db, id);
  if (!row) return { cancelled: false, draft: null, gmailDraftId: null };
  const cancelled = cancelSend(db, id);
  if (!cancelled) return { cancelled: false, draft: null, gmailDraftId: null };
  // The message never went out, so its receipt is not a receipt. The draft comes
  // back still armed, and sending again registers a fresh token.
  deleteReceiptForSend(db, id);
  const meta = sendMeta(row);
  return { cancelled: true, draft: meta.draft ?? null, gmailDraftId: meta.gmailDraftId ?? null };
}

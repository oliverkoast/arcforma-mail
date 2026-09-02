// The Scheduled view lists send_queue rows as pseudo-threads. A queued send
// carries the compose draft it was built from in meta_json, so the list row
// and the reading pane come from that draft, never from re-parsing the MIME.
// Pseudo-thread ids are "send:<row id>" so the thread IPC can tell them apart.

import type { SendQueueRow } from "@arcforma/store";
import type { Address, ComposeDraft, MessageView, ThreadSummary, ThreadView } from "../shared/types.js";

export const SEND_PREFIX = "send:";

export function isScheduledThreadId(threadId: string): boolean {
  return threadId.startsWith(SEND_PREFIX);
}

export function scheduledSendId(threadId: string): number | null {
  if (!isScheduledThreadId(threadId)) return null;
  const n = Number(threadId.slice(SEND_PREFIX.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function draftOf(row: SendQueueRow): ComposeDraft | null {
  try {
    const meta = JSON.parse(row.meta_json) as { draft?: ComposeDraft };
    return meta.draft ?? null;
  } catch {
    return null;
  }
}

function snippetOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** The list row for a queued send: recipients as participants, the subject, and send_at where the date goes. */
export function scheduledSummary(row: SendQueueRow, sender: Address): ThreadSummary {
  const draft = draftOf(row);
  const recipients: Address[] = draft ? [...draft.to, ...draft.cc] : [];
  return {
    accountId: row.account_id,
    id: `${SEND_PREFIX}${row.id}`,
    subject: draft?.subject ?? "",
    snippet: draft ? snippetOf(draft.bodyHtml) : "",
    participants: recipients.length ? recipients : [sender],
    lastMessageAt: row.send_at,
    sortAt: row.send_at,
    messageCount: 1,
    unread: false,
    starred: false,
    inInbox: false,
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
    scheduled: { sendId: row.id, sendAt: row.send_at },
  };
}

/** The reading pane for a queued send: one outbound message with the draft's body and quote, as it will go out. */
export function scheduledView(row: SendQueueRow, sender: Address): ThreadView {
  const thread = scheduledSummary(row, sender);
  const draft = draftOf(row);
  const html = draft ? `${draft.bodyHtml.trim() || "<p></p>"}${draft.quotedHtml.trim() ? `<br><div class="gmail_quote">${draft.quotedHtml}</div>` : ""}` : "<p></p>";
  const message: MessageView = {
    accountId: row.account_id,
    id: thread.id,
    threadId: thread.id,
    internalDate: row.send_at,
    from: sender,
    replyTo: null,
    to: draft?.to ?? [],
    cc: draft?.cc ?? [],
    bcc: draft?.bcc ?? [],
    messageIdHeader: null,
    references: draft?.references ?? null,
    subject: thread.subject,
    snippet: thread.snippet,
    labelIds: [],
    direction: "out",
    isAuto: false,
    hasAttachments: false,
    body: { html, text: null, attachments: [] },
    loadImages: false,
  };
  return { thread, messages: [message], bodiesPending: false };
}

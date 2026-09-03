import { ipcMain, shell } from "electron";
import { shouldLoadImages } from "../images.js";
import { fetchThreadFull, findBody, listAttachments } from "@arcforma/gmail";
import {
  archive,
  cancelSnooze,
  createReminder,
  createSnooze,
  getAccount,
  getBody,
  getContact,
  getSavedSearch,
  getSend,
  getThread,
  getThreadListRow,
  listBodies,
  listScheduledSends,
  listThreadMessages,
  listThreads,
  markRead,
  moveToInbox,
  parseAddressList,
  pendingSnooze,
  saveBody,
  search,
  setLoadImages,
  star,
  threadCounts,
  toggleQueue,
  trash,
  type Db,
  type InboxView as StoreView,
  type MessageRow,
  type ThreadListRow,
} from "@arcforma/store";
import type { AccountRegistry } from "../accounts.js";
import { previewKind } from "../attachments/kind.js";
import { attachmentKey, type StoredPart } from "../attachments/service.js";
import { categoryInfos } from "./ai.js";
import { requireAccount, requireEmail, requireId } from "./guard.js";
import { logError } from "../log.js";
import { scheduledSendId, scheduledSummary, scheduledView } from "../scheduled.js";
import type { Scheduler } from "../scheduler.js";
import { unsubscribeThread } from "../unsubscribe.js";
import type { SyncManager } from "../sync.js";
import type { Address, AttachmentInfo, CategoryInfo, ListRequest, ListResponse, MessageView, ThreadSummary, ThreadView, UnsubscribeResult } from "../../shared/types.js";

export function toSummary(row: ThreadListRow): ThreadSummary {
  return {
    accountId: row.account_id,
    id: row.id,
    subject: row.subject,
    snippet: row.snippet,
    participants: JSON.parse(row.participants_json) as Address[],
    lastMessageAt: row.last_message_at,
    sortAt: row.sort_at,
    messageCount: row.message_count,
    unread: row.unread === 1,
    starred: row.starred === 1,
    inInbox: row.in_inbox === 1,
    hasAttachments: row.has_attachments === 1,
    split: row.split ?? null,
    type: row.type ?? null,
    categoryId: row.category_id ?? null,
    attention: row.attention ?? null,
    band: row.band ?? null,
    attentionReason: row.attention_reason ?? null,
    wakeAt: row.wake_at ?? null,
    noReplyBy: row.no_reply_by ?? null,
    queue: row.queue ?? null,
    canUnsubscribe: row.can_unsubscribe === 1,
    unsubscribeState: row.unsubscribe_state ?? null,
  };
}

function toMessageView(db: Db, m: MessageRow): MessageView {
  const body = getBody(db, m.account_id, m.id);
  const contact = getContact(db, m.from_email);
  let replyTo: Address | null = null;
  // The store parses Bcc into its own column at sync time; the header is the fallback for a row written before it did.
  let bcc: Address[] = [];
  try {
    const headers = JSON.parse(m.headers_json) as Record<string, string>;
    replyTo = parseAddressList(headers["Reply-To"] ?? "")[0] ?? null;
    bcc = (JSON.parse(m.bcc_json) as Address[]) ?? [];
    if (!bcc.length) bcc = parseAddressList(headers["Bcc"] ?? "");
  } catch {
    replyTo = null;
  }
  return {
    accountId: m.account_id,
    id: m.id,
    threadId: m.thread_id,
    internalDate: m.internal_date,
    from: { email: m.from_email, name: m.from_name },
    replyTo,
    to: JSON.parse(m.to_json) as Address[],
    cc: JSON.parse(m.cc_json) as Address[],
    bcc,
    messageIdHeader: m.message_id_header,
    references: m.references_header,
    subject: m.subject,
    snippet: m.snippet,
    labelIds: JSON.parse(m.label_ids_json) as string[],
    direction: m.direction,
    isAuto: m.is_auto === 1,
    hasAttachments: m.has_attachments === 1,
    // Attachments cross as a key, a name, a type, and a size. The Gmail
    // attachment id and the inline base64 data stay in the main process: the
    // renderer asks for a part of a message, never for bytes or a path.
    body: body ? { html: body.html, text: body.text, attachments: attachmentInfos(body.attachments_json) } : null,
    loadImages: shouldLoadImages(db, m, contact?.load_images ?? null),
  };
}


/** The attachment list for one message body, as the renderer sees it. A part whose JSON is unreadable is left out rather than half shown. */
function attachmentInfos(attachmentsJson: string): AttachmentInfo[] {
  let parts: StoredPart[] = [];
  try {
    const parsed = JSON.parse(attachmentsJson) as StoredPart[];
    if (Array.isArray(parsed)) parts = parsed;
  } catch {
    return [];
  }
  return parts.map((a, i) => ({
    key: attachmentKey(a, i),
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    inline: a.inline,
    preview: previewKind(a.mimeType, a.filename),
  }));
}

function senderFor(db: Db, accountId: string): Address {
  const a = getAccount(db, accountId);
  return { email: a?.email ?? accountId, name: a?.display_name ?? "" };
}

/**
 * Two views do not come from the threads table: Scheduled lists queued sends
 * as pseudo-threads, and a saved search runs its query through FTS. Both are
 * a single page.
 */
export function listView(db: Db, req: ListRequest): ListResponse {
  if (req.view === "scheduled") {
    return { rows: listScheduledSends(db, req.accountIds).map((row) => scheduledSummary(row, senderFor(db, row.account_id))), nextCursor: null };
  }
  if (req.view.startsWith("search:")) {
    const saved = getSavedSearch(db, Number(req.view.slice(7)));
    if (!saved) return { rows: [], nextCursor: null };
    return { rows: search(db, saved.query, { accountIds: req.accountIds, limit: req.limit ?? 60 }).map((h) => toSummary(h.row)), nextCursor: null };
  }
  const page = listThreads(db, {
    view: req.view as StoreView,
    split: req.split ?? null,
    category: req.category ?? null,
    accountIds: req.accountIds,
    cursor: req.cursor ?? null,
    limit: req.limit ?? 60,
  });
  return { rows: page.rows.map(toSummary), nextCursor: page.nextCursor };
}

export function registerThreadIpc(db: Db, accounts: AccountRegistry, sync: SyncManager, scheduler?: Pick<Scheduler, "wakeSoon">): void {
  ipcMain.handle("threads:list", (_e, req: ListRequest) => listView(db, req));

  ipcMain.handle("threads:get", async (_e, accountId: string, threadId: string): Promise<ThreadView> => {
    const sendId = scheduledSendId(threadId);
    if (sendId !== null) {
      const send = getSend(db, sendId);
      if (!send || send.status !== "queued") throw new Error("That message is no longer waiting to send.");
      return scheduledView(send, senderFor(db, send.account_id));
    }
    const row = getThread(db, accountId, threadId);
    if (!row) throw new Error("That thread is no longer in the local store.");
    let messages = listThreadMessages(db, accountId, threadId);
    const cached = new Set(listBodies(db, accountId, threadId).map((b) => b.message_id));
    const missing = messages.filter((m) => !cached.has(m.id));
    let bodiesError: string | null = null;
    if (missing.length > 0) {
      const client = accounts.client(accountId);
      if (client) {
        try {
          const full = await fetchThreadFull(client, threadId);
          const known = new Set(messages.map((m) => m.id));
          for (const m of full.messages ?? []) {
            // Only messages the store knows: a body for a message the sync has not landed yet would violate the key.
            if (!known.has(m.id)) continue;
            const body = findBody(m.payload);
            saveBody(db, accountId, m.id, { html: body.html, text: body.text, attachments: listAttachments(m.payload) });
          }
          messages = listThreadMessages(db, accountId, threadId);
          const still = listBodies(db, accountId, threadId).length;
          if (still < messages.length) bodiesError = "Gmail did not return every message of this thread.";
        } catch (err) {
          bodiesError = (err as Error).message || "The message bodies could not be fetched.";
          logError("threads", `bodies for ${accountId}/${threadId}`, err);
        }
      } else {
        bodiesError = "Not signed in, so the message bodies cannot be fetched.";
      }
    }
    // The same columns the list carries, so the header shows the snooze, reminder, queue, and file state for any thread, not only the newest one.
    const summaryRow = getThreadListRow(db, accountId, threadId) ?? ({ ...row, split: null, type: null, category_id: null, attention: null, band: null, attention_reason: null, wake_at: null, no_reply_by: null, queue: null, unsubscribe_state: null, can_unsubscribe: 0 } as ThreadListRow);
    return { thread: toSummary(summaryRow), messages: messages.map((m) => toMessageView(db, m)), bodiesPending: bodiesError !== null, bodiesError };
  });

  // Every mutation checks the account and the thread first: a bad id would otherwise write an outbox row nothing can drain.
  const mutate = (fn: (accountId: string, threadId: string, ...rest: never[]) => void) => (_e: unknown, accountId: string, threadId: string, ...rest: unknown[]) => {
    requireAccount(db, accountId);
    if (!getThread(db, accountId, requireId(threadId, "thread"))) throw new Error("That thread is no longer in the local store.");
    (fn as (a: string, t: string, ...r: unknown[]) => void)(accountId, threadId, ...rest);
    sync.poke(accountId);
  };

  ipcMain.handle("threads:markRead", mutate((a, t, read: boolean) => markRead(db, a, t, read)));
  ipcMain.handle("threads:star", mutate((a, t, starred: boolean) => star(db, a, t, starred)));
  ipcMain.handle("threads:archive", mutate((a, t) => archive(db, a, t)));
  ipcMain.handle("threads:moveToInbox", mutate((a, t) => moveToInbox(db, a, t)));
  ipcMain.handle("threads:trash", mutate((a, t) => trash(db, a, t)));
  ipcMain.handle("threads:snooze", mutate((a, t, wakeAt: number) => createSnooze(db, { accountId: a, threadId: t, wakeAt })));
  // Undo after H. cancelSnooze puts INBOX back and takes the Snoozed label off, through the outbox like every other label change.
  ipcMain.handle("threads:unsnooze", (_e, accountId: string, threadId: string): boolean => {
    requireAccount(db, accountId);
    if (!getThread(db, accountId, requireId(threadId, "thread"))) throw new Error("That thread is no longer in the local store.");
    const row = pendingSnooze(db, accountId, threadId);
    if (!row) return false;
    const cancelled = cancelSnooze(db, row.id) !== null;
    if (cancelled) sync.poke(accountId);
    return cancelled;
  });
  ipcMain.handle("threads:remind", mutate((a, t, dueAt: number) => {
    const last = listThreadMessages(db, a, t).at(-1);
    if (!last) throw new Error("Nothing to remind about yet.");
    createReminder(db, { accountId: a, threadId: t, lastMessageId: last.id, dueAt });
  }));
  // U: the best List-Unsubscribe method, then archive. The result text is the toast.
  ipcMain.handle("threads:unsubscribe", async (_e, accountId: string, threadId: string): Promise<UnsubscribeResult> => {
    requireAccount(db, accountId);
    if (!getThread(db, accountId, requireId(threadId, "thread"))) throw new Error("That thread is no longer in the local store.");
    const result = await unsubscribeThread(db, accountId, threadId, { openExternal: (url) => shell.openExternal(url) });
    if (result.sendId !== null) scheduler?.wakeSoon(Date.now());
    if (result.archived || result.sendId !== null) sync.poke(accountId);
    return { method: result.method, ok: result.ok, archived: result.archived, state: result.state, text: result.text };
  });
  ipcMain.handle("threads:counts", (_e, accountIds?: string[]) => threadCounts(db, accountIds));
  // Queue membership is local only, so no sync poke: nothing about it goes to Gmail.
  ipcMain.handle("threads:toggleQueue", (_e, accountId: string, threadId: string, queue: unknown) => {
    requireAccount(db, accountId);
    if (!getThread(db, accountId, requireId(threadId, "thread"))) throw new Error("That thread is no longer in the local store.");
    if (queue !== "daily" && queue !== "weekly") throw new Error("Only Daily 0 and Weekly 0 take a thread by key.");
    return toggleQueue(db, accountId, threadId, queue);
  });
  ipcMain.handle("categories:list", (): CategoryInfo[] => categoryInfos(db));
  ipcMain.handle("contacts:setLoadImages", (_e, email: string, load: boolean) => setLoadImages(db, requireEmail(email), Boolean(load)));
}

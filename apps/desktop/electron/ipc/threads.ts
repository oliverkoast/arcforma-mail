import { ipcMain } from "electron";
import { shouldLoadImages } from "../images.js";
import { fetchThreadFull, findBody, listAttachments } from "@arcforma/gmail";
import {
  archive,
  createReminder,
  createSnooze,
  getAccount,
  getBody,
  getContact,
  getSavedSearch,
  getSend,
  getThread,
  listBodies,
  listScheduledSends,
  listThreadMessages,
  listThreads,
  markRead,
  moveToInbox,
  parseAddressList,
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
import { categoryInfos } from "./ai.js";
import { requireAccount, requireEmail, requireId } from "./guard.js";
import { logError } from "../log.js";
import { scheduledSendId, scheduledSummary, scheduledView } from "../scheduled.js";
import type { SyncManager } from "../sync.js";
import type { Address, CategoryInfo, ListRequest, ListResponse, MessageView, ThreadSummary, ThreadView } from "../../shared/types.js";

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
    wakeAt: row.wake_at ?? null,
    noReplyBy: row.no_reply_by ?? null,
    queue: row.queue ?? null,
  };
}

function toMessageView(db: Db, m: MessageRow): MessageView {
  const body = getBody(db, m.account_id, m.id);
  const contact = getContact(db, m.from_email);
  let replyTo: Address | null = null;
  try {
    const headers = JSON.parse(m.headers_json) as Record<string, string>;
    replyTo = parseAddressList(headers["Reply-To"] ?? "")[0] ?? null;
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
    messageIdHeader: m.message_id_header,
    references: m.references_header,
    subject: m.subject,
    snippet: m.snippet,
    labelIds: JSON.parse(m.label_ids_json) as string[],
    direction: m.direction,
    isAuto: m.is_auto === 1,
    hasAttachments: m.has_attachments === 1,
    body: body
      ? {
          html: body.html,
          text: body.text,
          attachments: (JSON.parse(body.attachments_json) as Array<{ filename: string; mimeType: string; size: number; inline: boolean }>).map((a) => ({
            filename: a.filename,
            mimeType: a.mimeType,
            size: a.size,
            inline: a.inline,
          })),
        }
      : null,
    loadImages: shouldLoadImages(db, m, contact?.load_images ?? null),
  };
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

export function registerThreadIpc(db: Db, accounts: AccountRegistry, sync: SyncManager): void {
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
    let bodiesPending = false;
    if (missing.length > 0) {
      const client = accounts.client(accountId);
      if (client) {
        try {
          const full = await fetchThreadFull(client, threadId);
          for (const m of full.messages ?? []) {
            const body = findBody(m.payload);
            saveBody(db, accountId, m.id, { html: body.html, text: body.text, attachments: listAttachments(m.payload) });
          }
          messages = listThreadMessages(db, accountId, threadId);
        } catch (err) {
          bodiesPending = true;
          logError("threads", `bodies for ${accountId}/${threadId}`, err);
        }
      } else {
        bodiesPending = true;
      }
    }
    const list = listThreads(db, { view: "all", accountIds: [accountId], limit: 1, cursor: null });
    const summaryRow = list.rows.find((r) => r.id === threadId) ?? ({ ...row, split: null, type: null, category_id: null, wake_at: null, no_reply_by: null, queue: null } as ThreadListRow);
    return { thread: toSummary(summaryRow), messages: messages.map((m) => toMessageView(db, m)), bodiesPending };
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
  ipcMain.handle("threads:remind", mutate((a, t, dueAt: number) => {
    const last = listThreadMessages(db, a, t).at(-1);
    if (!last) throw new Error("Nothing to remind about yet.");
    createReminder(db, { accountId: a, threadId: t, lastMessageId: last.id, dueAt });
  }));
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
